<script setup lang="ts">
const emit = defineEmits<{
  (e: 'sendKey', char: string): void;
}>();

const keys = [
  { label: 'Esc', key: 'Escape', char: '\x1b' },
  { label: 'Tab', key: 'Tab', char: '\t' },
  { label: 'Ctrl+C', key: 'CtrlC', char: '\x03' },
  { label: '↑', key: 'ArrowUp', char: '\x1b[A' },
  { label: '↓', key: 'ArrowDown', char: '\x1b[B' },
  { label: '←', key: 'ArrowLeft', char: '\x1b[D' },
  { label: '→', key: 'ArrowRight', char: '\x1b[C' },
  { label: '|', key: 'Pipe', char: '|' },
  { label: '/', key: 'Slash', char: '/' },
  { label: '~', key: 'Tilde', char: '~' },
  { label: '-', key: 'Dash', char: '-' },
];

function handlePress(e: PointerEvent, char: string) {
  e.preventDefault();
  emit('sendKey', char);
}
</script>

<template>
  <div
    class="flex items-center gap-1 p-1 bg-card border-t border-border overflow-x-auto select-none touch-none"
  >
    <button
      v-for="k in keys"
      :key="k.key"
      :data-key="k.key"
      class="px-2.5 py-1 text-xs font-mono font-medium bg-muted hover:bg-accent text-foreground rounded shadow-sm transition-colors active:bg-primary active:text-primary-foreground"
      @pointerdown="handlePress($event, k.char)"
    >
      {{ k.label }}
    </button>
  </div>
</template>
