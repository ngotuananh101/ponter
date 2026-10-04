<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{ open: boolean; initialName: string }>();
const emit = defineEmits<{
  (e: 'confirm', name: string): void;
  (e: 'cancel'): void;
}>();

const name = ref(props.initialName);

watch(
  () => props.open,
  (v) => {
    if (v) name.value = props.initialName;
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
    data-test="rename-dialog"
    open
    @click.self="emit('cancel')"
  >
    <form @submit.prevent="onConfirm">
      <label for="rename-input">Rename</label>
      <input
        id="rename-input"
        data-test="rename-input"
        v-model="name"
        type="text"
        size="32"
        autocomplete="off"
        @keydown="onKeydown"
      />
      <div class="dialog-actions">
        <button type="button" data-test="rename-confirm" @click="onConfirm">
          OK
        </button>
        <button type="button" data-test="rename-cancel" @click="emit('cancel')">
          Cancel
        </button>
      </div>
    </form>
  </dialog>
</template>
