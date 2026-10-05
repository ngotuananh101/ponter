<script setup lang="ts">
import { ref } from 'vue';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Shield, KeyRound, User, Mail, Lock } from '@lucide/vue';

defineProps<{
  loading?: boolean;
  errorMessage?: string | null;
}>();

const emit = defineEmits<{
  (
    e: 'submit',
    payload: { username: string; email?: string; password: string },
  ): void;
}>();

const username = ref('');
const email = ref('');
const password = ref('');
const confirmPassword = ref('');
const validationError = ref<string | null>(null);

function validateEmail(val: string): boolean {
  return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(val);
}

function handleSubmit() {
  validationError.value = null;
  const trimmedUser = username.value.trim();
  const trimmedEmail = email.value.trim();

  if (!trimmedUser || trimmedUser.length < 3) {
    validationError.value = 'Username must be at least 3 characters';
    return;
  }

  if (trimmedEmail && !validateEmail(trimmedEmail)) {
    validationError.value = 'Please enter a valid email address';
    return;
  }

  if (password.value.length < 8) {
    validationError.value = 'Password must be at least 8 characters';
    return;
  }

  if (password.value !== confirmPassword.value) {
    validationError.value = 'Passwords do not match';
    return;
  }

  emit('submit', {
    username: trimmedUser,
    email: trimmedEmail || undefined,
    password: password.value,
  });
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
          <KeyRound class="w-5 h-5" />
        </div>
        <div
          class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-secondary text-muted-foreground text-xs font-mono"
        >
          <Shield class="w-3.5 h-3.5 text-primary" />
          <span>Password-Derived Keys</span>
        </div>
      </div>
      <div>
        <CardTitle class="text-2xl font-bold tracking-tight"
          >Create an account</CardTitle
        >
        <CardDescription class="text-sm text-muted-foreground mt-0.5">
          Enter your details to generate your secure identity
        </CardDescription>
      </div>
    </CardHeader>
    <form @submit.prevent="handleSubmit">
      <CardContent class="space-y-4">
        <Alert
          v-if="validationError || errorMessage"
          variant="destructive"
          class="border-destructive/30 bg-destructive/10"
        >
          <AlertDescription class="text-xs font-medium">{{
            validationError || errorMessage
          }}</AlertDescription>
        </Alert>

        <div class="space-y-2">
          <Label
            for="reg-username"
            class="text-xs font-medium text-foreground flex items-center gap-1.5"
          >
            <User class="w-3.5 h-3.5 text-muted-foreground" />
            Username
          </Label>
          <Input
            id="reg-username"
            v-model="username"
            type="text"
            placeholder="Username (min 3 chars)"
            autocomplete="username"
            :disabled="loading"
            class="bg-background/60 font-mono text-sm focus-visible:ring-primary"
          />
        </div>

        <div class="space-y-2">
          <Label
            for="reg-email"
            class="text-xs font-medium text-foreground flex items-center gap-1.5"
          >
            <Mail class="w-3.5 h-3.5 text-muted-foreground" />
            Email (optional)
          </Label>
          <Input
            id="reg-email"
            v-model="email"
            type="email"
            placeholder="name@example.com"
            autocomplete="email"
            :disabled="loading"
            class="bg-background/60 font-mono text-sm focus-visible:ring-primary"
          />
        </div>

        <div class="space-y-2">
          <Label
            for="reg-password"
            class="text-xs font-medium text-foreground flex items-center gap-1.5"
          >
            <Lock class="w-3.5 h-3.5 text-muted-foreground" />
            Password
          </Label>
          <Input
            id="reg-password"
            v-model="password"
            type="password"
            placeholder="Password (min 8 chars)"
            autocomplete="new-password"
            :disabled="loading"
            class="bg-background/60 font-mono text-sm focus-visible:ring-primary"
          />
        </div>

        <div class="space-y-2">
          <Label
            for="reg-confirm-password"
            class="text-xs font-medium text-foreground flex items-center gap-1.5"
          >
            <Lock class="w-3.5 h-3.5 text-muted-foreground" />
            Confirm Password
          </Label>
          <Input
            id="reg-confirm-password"
            v-model="confirmPassword"
            type="password"
            placeholder="Repeat password"
            autocomplete="new-password"
            :disabled="loading"
            class="bg-background/60 font-mono text-sm focus-visible:ring-primary"
          />
        </div>
      </CardContent>
      <CardFooter class="flex flex-col space-y-3 pt-2">
        <Button type="submit" class="w-full font-medium" :disabled="loading">
          <span v-if="loading" class="flex items-center gap-2">
            <span
              class="w-4 h-4 border-2 border-primary-foreground/30 border-t-primary-foreground rounded-full animate-spin"
            ></span>
            Generating Keys & Registering...
          </span>
          <span v-else>Register</span>
        </Button>
        <div class="text-center text-xs text-muted-foreground">
          Already have an account?
          <router-link
            to="/login"
            class="text-primary hover:underline font-medium ml-1"
          >
            Sign In
          </router-link>
        </div>
      </CardFooter>
    </form>
  </Card>
</template>
