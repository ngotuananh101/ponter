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
  // Domain labels exclude `.` so there is exactly one way to match each dot;
  // the original `[^\s@]+\.` had overlapping classes and backtracked
  // super-linearly on adversarial input.
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
  <Card class="w-full max-w-md mx-auto shadow-md">
    <CardHeader class="space-y-1">
      <CardTitle class="text-2xl font-bold tracking-tight"
        >Create an account</CardTitle
      >
      <CardDescription
        >Enter your details to generate your secure identity</CardDescription
      >
    </CardHeader>
    <form @submit.prevent="handleSubmit">
      <CardContent class="space-y-4">
        <Alert v-if="validationError || errorMessage" variant="destructive">
          <AlertDescription>{{
            validationError || errorMessage
          }}</AlertDescription>
        </Alert>

        <div class="space-y-2">
          <Label for="reg-username">Username</Label>
          <Input
            id="reg-username"
            v-model="username"
            type="text"
            placeholder="Username (min 3 chars)"
            autocomplete="username"
            :disabled="loading"
          />
        </div>

        <div class="space-y-2">
          <Label for="reg-email">Email (optional)</Label>
          <Input
            id="reg-email"
            v-model="email"
            type="email"
            placeholder="name@example.com"
            autocomplete="email"
            :disabled="loading"
          />
        </div>

        <div class="space-y-2">
          <Label for="reg-password">Password</Label>
          <Input
            id="reg-password"
            v-model="password"
            type="password"
            placeholder="Password (min 8 chars)"
            autocomplete="new-password"
            :disabled="loading"
          />
        </div>

        <div class="space-y-2">
          <Label for="reg-confirm-password">Confirm Password</Label>
          <Input
            id="reg-confirm-password"
            v-model="confirmPassword"
            type="password"
            placeholder="Repeat password"
            autocomplete="new-password"
            :disabled="loading"
          />
        </div>
      </CardContent>
      <CardFooter class="flex flex-col space-y-3">
        <Button type="submit" class="w-full" :disabled="loading">
          <span v-if="loading">Generating Keys & Registering...</span>
          <span v-else>Register</span>
        </Button>
        <div class="text-center text-sm text-muted-foreground">
          Already have an account?
          <router-link
            to="/login"
            class="text-primary hover:underline font-medium"
          >
            Sign In
          </router-link>
        </div>
      </CardFooter>
    </form>
  </Card>
</template>
