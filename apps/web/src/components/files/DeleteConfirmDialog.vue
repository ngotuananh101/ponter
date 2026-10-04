<script setup lang="ts">
defineProps<{
  open: boolean;
  name: string;
  isDirectory: boolean;
}>();
const emit = defineEmits<{
  (e: 'confirm', recursive: boolean): void;
  (e: 'cancel'): void;
}>();

function onDelete(recursive: boolean): void {
  emit('confirm', recursive);
}
</script>

<template>
  <dialog
    v-if="open"
    data-test="delete-dialog"
    open
    @click.self="emit('cancel')"
  >
    <form method="dialog">
      <p>
        Delete <strong>{{ name }}</strong
        >?
        <span v-if="isDirectory">
          This is a directory. Deleting it removes its contents.
        </span>
      </p>
      <div class="dialog-actions">
        <button data-test="delete-confirm" @click="onDelete(isDirectory)">
          {{ isDirectory ? 'Delete folder' : 'Delete' }}
        </button>
        <button @click="emit('cancel')">Cancel</button>
      </div>
    </form>
  </dialog>
</template>
