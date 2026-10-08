<script setup lang="ts">
import { onMounted } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { useDevicesStore } from '@/stores/devices';

const authStore = useAuthStore();
const store = useDevicesStore();

async function handleRegister() {
  await store.register();
}

async function handleDelete(deviceId: string) {
  const confirmed = window.confirm(
    `Delete device "${deviceId}"? This cannot be undone.`,
  );
  if (!confirmed) return;
  await store.remove(deviceId);
}

onMounted(() => {
  void store.refresh();
});
</script>

<template>
  <div data-testid="devices-root">
    <header class="devices-header">
      <p data-testid="devices-username">
        Signed in as {{ authStore.user?.username }}
      </p>
      <h2>Devices</h2>
    </header>

    <p v-if="store.error" data-testid="devices-error">{{ store.error }}</p>

    <div v-if="store.loading" data-testid="devices-loading">
      Loading devices...
    </div>

    <p v-else-if="store.devices.length === 0" data-testid="devices-empty">
      No devices registered yet
    </p>

    <ul v-else data-testid="devices-list">
      <li
        v-for="device in store.devices"
        :key="device.id"
        data-testid="device-row"
      >
        <span data-testid="device-id">{{ device.id }}</span>
        <span data-testid="device-hostname">{{ device.hostname }}</span>
        <span data-testid="device-platform">{{
          device.platform ?? 'unknown'
        }}</span>
        <span data-testid="device-online">
          {{ device.isOnline ? 'online' : 'offline' }}
        </span>
        <span data-testid="device-created">{{ device.createdAt }}</span>
        <button
          data-testid="device-delete"
          :data-testid-device="device.id"
          @click="handleDelete(device.id)"
        >
          Delete
        </button>
      </li>
    </ul>

    <footer class="devices-footer">
      <button
        data-testid="devices-register"
        :disabled="store.loading"
        @click="handleRegister"
      >
        {{ store.loading ? 'Registering...' : 'Register this device' }}
      </button>
      <p v-if="!store.registered" data-testid="devices-register-hint">
        The agent runtime starts from the tray — arriving in Task 7.
      </p>
    </footer>
  </div>
</template>

<style>
.devices-header {
  padding: 1rem;
  border-bottom: 1px solid #e0e0e0;
}

.devices-header p {
  color: #666;
  font-size: 0.9rem;
}

.devices-footer {
  padding: 1rem;
  border-top: 1px solid #e0e0e0;
}

.devices-footer p {
  color: #666;
  font-size: 0.85rem;
}

[data-testid='devices-list'] {
  list-style: none;
  padding: 0;
  margin: 0;
}

[data-testid='device-row'] {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid #f0f0f0;
}
</style>
