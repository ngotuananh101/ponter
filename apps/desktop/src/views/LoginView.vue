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
import { Terminal, ShieldCheck, User, Lock, Loader2 } from '@lucide/vue';
import ThemeToggle from '@/components/ThemeToggle.vue';

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
  <main class="w-full max-w-md">
    <h1 class="sr-only">Login</h1>
    <Card class="border-border/80 bg-card/95 shadow-xl backdrop-blur-sm">
      <CardHeader class="space-y-2 pb-4">
        <div class="flex items-center justify-between">
          <div
            class="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary"
          >
            <Terminal class="w-5 h-5" />
          </div>
          <div class="flex items-center gap-2">
            <div
              class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary text-muted-foreground text-xs font-mono"
            >
              <ShieldCheck class="w-3.5 h-3.5 text-primary" />
              <span>Token Auth</span>
            </div>
            <ThemeToggle />
          </div>
        </div>
        <div>
          <CardTitle class="text-2xl font-bold tracking-tight"
            >Ponter Desktop</CardTitle
          >
          <CardDescription class="text-sm text-muted-foreground mt-0.5">
            Sign in to your Ponter account
          </CardDescription>
        </div>
        <div
          class="flex items-center justify-between p-2 rounded-md bg-muted/40 border border-border/60 text-xs font-mono text-muted-foreground"
          data-testid="login-server-line"
        >
          <span class="truncate"
            >Server: {{ config.serverUrl || 'not set' }}</span
          >
          <button
            type="button"
            data-testid="login-change-server"
            class="ml-2 text-primary hover:underline font-medium cursor-pointer"
            @click="config.editing = true"
          >
            Change
          </button>
        </div>
      </CardHeader>
      <CardContent>
        <form @submit.prevent="handleSubmit" class="space-y-4">
          <div class="space-y-2">
            <Label
              for="login-username"
              class="text-xs font-medium text-foreground flex items-center gap-1.5"
            >
              <User class="w-3.5 h-3.5 text-muted-foreground" />
              Username
            </Label>
            <Input
              id="login-username"
              data-testid="login-username"
              v-model="username"
              type="text"
              placeholder="Username"
              autocomplete="username"
              :disabled="store.status === 'loading'"
              class="bg-background/60 text-sm focus-visible:ring-primary"
            />
          </div>
          <div class="space-y-2">
            <Label
              for="login-password"
              class="text-xs font-medium text-foreground flex items-center gap-1.5"
            >
              <Lock class="w-3.5 h-3.5 text-muted-foreground" />
              Password
            </Label>
            <Input
              id="login-password"
              data-testid="login-password"
              v-model="password"
              type="password"
              placeholder="Password"
              autocomplete="current-password"
              :disabled="store.status === 'loading'"
              class="bg-background/60 text-sm focus-visible:ring-primary"
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
            class="w-full font-medium"
          >
            <Loader2
              v-if="store.status === 'loading'"
              class="mr-2 h-4 w-4 animate-spin"
            />
            {{ store.status === 'loading' ? 'Signing in...' : 'Sign in' }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </main>
</template>
