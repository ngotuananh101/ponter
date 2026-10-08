<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import type { TerminalSession } from '@ponter/terminal-core';

const props = defineProps<{
  session: TerminalSession;
}>();

const containerRef = ref<HTMLDivElement | null>(null);
let terminal: Terminal | null = null;
let fitAddon: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;
let unsubData: (() => void) | null = null;

function initTerminal() {
  if (!containerRef.value) return;

  terminal = new Terminal({
    cursorBlink: true,
    fontFamily: 'JetBrains Mono, Menlo, Monaco, "Courier New", monospace',
    fontSize: 14,
    theme: {
      background: '#090d16',
      foreground: '#f8fafc',
      cursor: '#38bdf8',
      selectionBackground: '#1e293b',
      black: '#0f172a',
      red: '#ef4444',
      green: '#22c55e',
      yellow: '#eab308',
      blue: '#3b82f6',
      magenta: '#d946ef',
      cyan: '#06b6d4',
      white: '#f8fafc',
      brightBlack: '#64748b',
      brightRed: '#f87171',
      brightGreen: '#4ade80',
      brightYellow: '#fde047',
      brightBlue: '#60a5fa',
      brightMagenta: '#e879f9',
      brightCyan: '#22d3ee',
      brightWhite: '#ffffff',
    },
  });

  fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(new WebLinksAddon());

  terminal.open(containerRef.value);
  fitAddon.fit();

  // Playback buffer
  const initialBytes = props.session.buffer.getAll();
  if (initialBytes.length > 0) {
    terminal.write(initialBytes);
  }

  // Bind input -> session
  terminal.onData((data) => {
    props.session.write(data);
  });

  // Bind session output -> terminal
  unsubData = props.session.onData((chunk) => {
    terminal?.write(chunk);
  });

  // Observe resize
  resizeObserver = new ResizeObserver(() => {
    if (!fitAddon || !terminal) return;
    try {
      fitAddon.fit();
      if (terminal.cols >= 1 && terminal.rows >= 1) {
        props.session.resize(terminal.cols, terminal.rows);
      }
    } catch {
      // ignore fit calculation errors when container is hidden
    }
  });
  resizeObserver.observe(containerRef.value);
}

onMounted(() => {
  initTerminal();
});

onBeforeUnmount(() => {
  if (unsubData) unsubData();
  if (resizeObserver) resizeObserver.disconnect();
  if (terminal) terminal.dispose();
});
</script>

<template>
  <div class="w-full h-full bg-terminal-bg p-2 overflow-hidden flex flex-col">
    <div ref="containerRef" class="terminal-container flex-1 w-full h-full" />
  </div>
</template>

<style scoped>
.terminal-container :deep(.xterm) {
  height: 100%;
}

/* xterm owns its own scroll container, so it cannot be wrapped in the shadcn
   `ScrollArea`. Since xterm 6 the scrollable part is an internal
   `.xterm-scrollable-element` whose VS Code-derived scrollbar is themed by a
   `<style>` element xterm injects — the old `.xterm-viewport::-webkit-scrollbar`
   rules no longer match anything. Restyle the slider to match the ScrollArea
   used by the sidebar and tab strip: rounded, low-contrast until hovered or
   dragged. The `:deep()` selector out-specifies xterm's injected rule, so no
   `!important` is needed. */
.terminal-container :deep(.xterm-scrollable-element > .scrollbar > .slider) {
  background: var(--border);
  border-radius: 9999px;
}

.terminal-container
  :deep(.xterm-scrollable-element > .scrollbar > .slider:hover) {
  background: var(--muted-foreground);
}

.terminal-container
  :deep(.xterm-scrollable-element > .scrollbar > .slider.active) {
  background: var(--muted-foreground);
}
</style>
