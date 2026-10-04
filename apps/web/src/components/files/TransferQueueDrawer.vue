<script setup lang="ts">
import { computed } from 'vue';
import { X } from '@lucide/vue';

interface TransferEntry {
  transferId: string;
  direction: 'upload' | 'download';
  bytesTransferred: number;
  totalBytes: number;
  chunkIndex: number;
  name: string;
  paused?: boolean;
}

const props = defineProps<{
  open: boolean;
  tabId: string;
  transfers: TransferEntry[];
}>();
const emit = defineEmits<{
  (e: 'pause', id: string): void;
  (e: 'resume', id: string): void;
  (e: 'cancel', id: string): void;
  (e: 'close'): void;
}>();

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ['KiB', 'MiB', 'GiB'] as const;
  let value = size;
  let unit: (typeof units)[number] = 'KiB';
  for (const u of units) {
    unit = u;
    value /= 1024;
    if (value < 1024) break;
  }
  return `${value.toFixed(1)} ${unit}`;
}

const visible = computed(() => props.transfers);
</script>

<template>
  <aside
    v-if="open"
    data-test="transfer-drawer"
    :class="['transfer-drawer', open ? 'open' : '']"
    tabindex="-1"
    @click.self="emit('close')"
  >
    <header class="transfer-drawer-header">
      <h2>Transfers</h2>
      <button
        data-test="transfer-drawer-close"
        aria-label="Close transfers"
        @click="emit('close')"
      >
        <X class="w-4 h-4" />
      </button>
    </header>

    <ul v-if="visible.length" class="transfer-drawer-list">
      <li
        v-for="t in visible"
        :key="t.transferId"
        :data-test="`queue-item-${t.transferId}`"
        class="transfer-drawer-row"
      >
        <span class="transfer-drawer-name truncate">{{ t.name }}</span>

        <div class="transfer-drawer-bar-group">
          <div
            class="transfer-drawer-bar"
            :style="{
              width:
                t.totalBytes > 0
                  ? `${Math.min(100, (t.bytesTransferred / t.totalBytes) * 100)}%`
                  : '0%',
            }"
          ></div>
        </div>

        <span class="transfer-drawer-meta">
          <span class="transfer-drawer-size"
            >{{ formatSize(t.bytesTransferred) }} /
            {{ formatSize(t.totalBytes) }}</span
          >
          <span v-if="!t.paused" class="transfer-drawer-speed">active</span>
          <span v-else class="transfer-drawer-speed paused">paused</span>
        </span>

        <div class="transfer-drawer-actions">
          <button
            :data-test="`queue-resume-${t.transferId}`"
            :aria-label="`Resume transfer ${t.name}`"
            @click="emit('resume', t.transferId)"
          >
            ▶
          </button>
          <button
            :data-test="`queue-pause-${t.transferId}`"
            :aria-label="`Pause transfer ${t.name}`"
            @click="emit('pause', t.transferId)"
          >
            ⏸
          </button>
          <button
            :data-test="`queue-cancel-${t.transferId}`"
            :aria-label="`Cancel transfer ${t.name}`"
            @click="emit('cancel', t.transferId)"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
      </li>
    </ul>

    <p v-else class="transfer-drawer-empty">No active transfers</p>
  </aside>
</template>

<style scoped>
.transfer-drawer {
  position: fixed;
  bottom: 0;
  right: 0;
  top: 0;
  width: 340px;
  max-width: 90vw;
  transform: translateX(100%);
  transition: transform 0.2s ease;
  z-index: 100;
  background: var(--card, #fff);
  border: 1px solid var(--border, #e0e0e0);
  box-shadow: -4px 0 12px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
}
.transfer-drawer.open {
  transform: translateX(0);
}
.transfer-drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border, #e0e0e0);
}
.transfer-drawer-header h2 {
  font-size: 0.9rem;
  font-weight: 600;
  margin: 0;
}
.transfer-drawer-header button {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.25rem;
  color: var(--muted-foreground, #666);
}
.transfer-drawer-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}
.transfer-drawer-row {
  display: grid;
  grid-template-columns: 1fr auto 1fr auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid var(--border, #e0e0e0);
  font-size: 0.8rem;
}
.transfer-drawer-row:last-child {
  border-bottom: none;
}
.transfer-drawer-name {
  grid-column: 1 / -1;
  max-width: 100%;
}
.transfer-drawer-bar-group {
  grid-column: 1 / -1;
  background: var(--muted, #f5f5f5);
  border-radius: 2px;
  height: 4px;
  overflow: hidden;
}
.transfer-drawer-bar {
  height: 100%;
  background: var(--primary, #3b82f6);
  transition: width 0.1s ease;
}
.transfer-drawer-meta {
  grid-column: 1 / -1;
  display: flex;
  gap: 0.5rem;
  font-family: monospace;
  color: var(--muted-foreground, #666);
}
.transfer-drawer-actions {
  grid-column: 4 / -1;
  display: flex;
  gap: 0.25rem;
}
.transfer-drawer-actions button {
  background: none;
  border: none;
  cursor: pointer;
  padding: 0.25rem;
  color: var(--muted-foreground, #666);
}
.transfer-drawer-actions button:hover {
  color: var(--foreground, #000);
}
.transfer-drawer-empty {
  padding: 1rem;
  text-align: center;
  color: var(--muted-foreground, #666);
  font-size: 0.8rem;
}
</style>
