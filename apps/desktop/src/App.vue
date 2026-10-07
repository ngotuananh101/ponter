<script setup lang="ts">
import { ref, onMounted } from "vue";
import { invoke } from "@tauri-apps/api/core";

const spikeResult = ref<string | null>(null);
const spikeError = ref<string | null>(null);

onMounted(async () => {
  try {
    const result = await invoke("spike_start");
    spikeResult.value = result as string;
    // Also log to the console so the boot log proves the backend command ran.
    console.log("[spike] backend command spike_start returned:", result);
  } catch (e) {
    spikeError.value = String(e);
    console.error("[spike] invoke failed:", e);
  }
});
</script>

<template>
  <main class="container">
    <h1>Ponta Desktop — L0 Tauri Spike</h1>

    <p v-if="spikeResult">
      Backend command result: <strong>{{ spikeResult }}</strong>
    </p>
    <p v-else-if="spikeError">
      Invoke failed: {{ spikeError }}
    </p>
    <p v-else>
      Starting...
    </p>
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

  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  -webkit-text-size-adjust: 100%;
}

.container {
  margin: 0;
  padding-top: 10vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  text-align: center;
}

a {
  font-weight: 500;
  color: #646cff;
  text-decoration: inherit;
}

a:hover {
  color: #535bf2;
}

h1 {
  text-align: center;
}

@media (prefers-color-scheme: dark) {
  :root {
    color: #f6f6f6;
    background-color: #2f2f2f;
  }

  a:hover {
    color: #24c8db;
  }
}
</style>
