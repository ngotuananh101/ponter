<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '@/stores/auth';

const store = useAuthStore();
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
  <main class="container">
    <h1>Ponter Desktop</h1>
    <form @submit.prevent="handleSubmit">
      <div>
        <label for="login-username">Username</label>
        <input
          id="login-username"
          data-testid="login-username"
          v-model="username"
          type="text"
        />
      </div>
      <div>
        <label for="login-password">Password</label>
        <input
          id="login-password"
          data-testid="login-password"
          v-model="password"
          type="password"
        />
      </div>
      <button
        data-testid="login-submit"
        type="submit"
        :disabled="store.status === 'loading'"
      >
        {{ store.status === 'loading' ? 'Signing in...' : 'Sign in' }}
      </button>
      <p v-if="store.error" data-testid="login-error">{{ store.error }}</p>
    </form>
  </main>
</template>

<style>
:root {
  font-family: Inter, Avenir, Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 24px;
  font-weight: 400;
  color: #0f0f0f;
  background-color: #f6f6f6;
}

.container {
  margin: 0;
  padding-top: 10vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
}
</style>
