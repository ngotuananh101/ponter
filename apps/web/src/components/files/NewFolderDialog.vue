<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: 'confirm', name: string): void;
  (e: 'cancel'): void;
}>();

const name = ref('');

// Reset when closed so a reopened dialog starts clean.
watch(
  () => props.open,
  (v) => {
    if (v) name.value = '';
  },
);

function onConfirm(): void {
  const trimmed = name.value.trim();
  if (!trimmed) return;
  emit('confirm', trimmed);
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('cancel');
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    onConfirm();
  }
}
</script>

<template>
  <dialog
    v-if="open"
    data-test="new-folder-dialog"
    open
    @click.self="emit('cancel')"
  >
    <form @submit.prevent="onConfirm">
      <label for="new-folder-input">New folder name</label>
      <input
        id="new-folder-input"
        data-test="new-folder-input"
        v-model="name"
        type="text"
        size="32"
        autocomplete="off"
        @keydown="onKeydown"
      />
      <div class="dialog-actions">
        <button type="button" data-test="new-folder-confirm" @click="onConfirm">
          Create
        </button>
        <button
          type="button"
          data-test="new-folder-cancel"
          @click="emit('cancel')"
        >
          Cancel
        </button>
      </div>
    </form>
  </dialog>
</template>
