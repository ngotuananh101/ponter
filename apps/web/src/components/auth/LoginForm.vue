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
  (e: 'submit', payload: { username: string; password: string }): void;
}>();

const username = ref('');
const password = ref('');
const validationError = ref<string | null>(null);

function handleSubmit() {
  validationError.value = null;
  if (!username.value.trim() || !password.value) {
    validationError.value = 'Please enter both username and password';
    return;
  }
  emit('submit', { username: username.value.trim(), password: password.value });
}
</script>

<template>
  <Card class="w-full max-w-md mx-auto shadow-md">
    <CardHeader class="space-y-1">
      <CardTitle class="text-2xl font-bold tracking-tight">Login</CardTitle>
      <CardDescription
        >Enter your credentials to access your account</CardDescription
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
          <Label for="username">Username</Label>
          <Input
            id="username"
            v-model="username"
            type="text"
            placeholder="Username"
            autocomplete="username"
            :disabled="loading"
          />
        </div>

        <div class="space-y-2">
          <Label for="password">Password</Label>
          <Input
            id="password"
            v-model="password"
            type="password"
            placeholder="Password"
            autocomplete="current-password"
            :disabled="loading"
          />
        </div>
      </CardContent>
      <CardFooter class="flex flex-col space-y-3">
        <Button type="submit" class="w-full" :disabled="loading">
          <span v-if="loading">Signing in...</span>
          <span v-else>Sign In</span>
        </Button>
        <div class="text-center text-sm text-muted-foreground">
          Don't have an account?
          <router-link
            to="/register"
            class="text-primary hover:underline font-medium"
          >
            Register
          </router-link>
        </div>
      </CardFooter>
    </form>
  </Card>
</template>
