<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useConfigStore } from '@/stores/config';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';

const store = useAuthStore();
const config = useConfigStore();
const username = ref('');
const password = ref('');

async function handleSubmit() {
  if (!username.value.trim() || !password.value) return;
  try {
    await store.login(username.value.trim(), password.value);
  } catch {
    // error surfaced via store.error and the view
  }
}
</script>

<template>
  <main
    class="container flex min-h-screen flex-col items-center justify-center"
  >
    <h1 class="sr-only">Login</h1>
    <Card class="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Ponter Desktop</CardTitle>
        <CardDescription>Sign in to your Ponter account</CardDescription>
      </CardHeader>
      <CardContent>
        <p
          class="mb-3 text-xs text-muted-foreground"
          data-testid="login-server-line"
        >
          Server: {{ config.serverUrl || 'not set' }}
          <button
            type="button"
            data-testid="login-change-server"
            class="ml-1 underline"
            @click="config.editing = true"
          >
            Change
          </button>
        </p>
        <form @submit.prevent="handleSubmit" class="space-y-4">
          <div class="space-y-2">
            <Label for="login-username">Username</Label>
            <Input
              id="login-username"
              data-testid="login-username"
              v-model="username"
              type="text"
            />
          </div>
          <div class="space-y-2">
            <Label for="login-password">Password</Label>
            <Input
              id="login-password"
              data-testid="login-password"
              v-model="password"
              type="password"
            />
          </div>
          <Alert
            v-if="store.error"
            data-testid="login-error"
            variant="destructive"
            role="alert"
            aria-live="polite"
          >
            <AlertDescription>{{ store.error }}</AlertDescription>
          </Alert>
          <Button
            data-testid="login-submit"
            type="submit"
            :disabled="store.status === 'loading'"
            class="w-full"
          >
            {{ store.status === 'loading' ? 'Signing in...' : 'Sign in' }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </main>
</template>
