<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { ShieldCheck, Lock, User, Terminal, Loader2 } from '@lucide/vue';
import { toast } from 'vue-sonner';

const props = defineProps<{
  loading?: boolean;
  errorMessage?: string | null;
}>();

const emit = defineEmits<{
  (e: 'submit', payload: { username: string; password: string }): void;
}>();

const username = ref('');
const password = ref('');

watch(
  () => props.errorMessage,
  (msg) => {
    if (msg) toast.error(msg);
  },
);

function handleSubmit() {
  if (!username.value.trim() || !password.value) {
    toast.error('Please enter both username and password');
    return;
  }
  emit('submit', { username: username.value.trim(), password: password.value });
}
</script>

<template>
  <Card
    class="w-full max-w-md mx-auto border-border/80 bg-card/95 shadow-xl backdrop-blur-sm"
  >
    <CardHeader class="space-y-2 pb-4">
      <div class="flex items-center justify-between">
        <div
          class="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary"
        >
          <Terminal class="w-5 h-5" />
        </div>
        <div
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary text-muted-foreground text-xs font-mono"
        >
          <ShieldCheck class="w-3.5 h-3.5 text-primary" />
          <span>Token Auth</span>
        </div>
      </div>
      <div>
        <CardTitle class="text-2xl font-bold tracking-tight">Login</CardTitle>
        <CardDescription class="text-sm text-muted-foreground mt-0.5">
          Enter your credentials to access your account
        </CardDescription>
      </div>
    </CardHeader>
    <form @submit.prevent="handleSubmit">
      <CardContent class="space-y-4">
        <div class="space-y-2">
          <Label
            for="username"
            class="text-xs font-medium text-foreground flex items-center gap-1.5"
          >
            <User class="w-3.5 h-3.5 text-muted-foreground" />
            Username
          </Label>
          <Input
            id="username"
            v-model="username"
            type="text"
            placeholder="Username"
            autocomplete="username"
            :disabled="loading"
            class="bg-background/60 text-sm focus-visible:ring-primary"
          />
        </div>

        <div class="space-y-2">
          <Label
            for="password"
            class="text-xs font-medium text-foreground flex items-center gap-1.5"
          >
            <Lock class="w-3.5 h-3.5 text-muted-foreground" />
            Password
          </Label>
          <Input
            id="password"
            v-model="password"
            type="password"
            placeholder="Password"
            autocomplete="current-password"
            :disabled="loading"
            class="bg-background/60 text-sm focus-visible:ring-primary"
          />
        </div>
      </CardContent>
      <CardFooter class="flex flex-col space-y-3 pt-2">
        <Button type="submit" class="w-full font-medium" :disabled="loading">
          <span v-if="loading" class="flex items-center gap-2">
            <Loader2 class="w-4 h-4 animate-spin" />
            Signing in...
          </span>
          <span v-else>Sign In</span>
        </Button>
        <div class="text-center text-xs text-muted-foreground">
          Don't have an account?
          <router-link
            to="/register"
            class="text-primary hover:underline font-medium ml-1"
          >
            Register
          </router-link>
        </div>
      </CardFooter>
    </form>
  </Card>
</template>
