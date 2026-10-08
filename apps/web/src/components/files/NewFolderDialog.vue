<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: 'confirm', name: string): void;
  (e: 'cancel'): void;
}>();

const name = ref('');
const pendingConfirm = ref(false);

// Reset when opened so a reopened dialog starts clean.
watch(
  () => props.open,
  (v) => {
    if (v) name.value = '';
  },
);

function onConfirm(): void {
  const trimmed = name.value.trim();
  if (!trimmed) return;
  pendingConfirm.value = true;
  emit('confirm', trimmed);
}
</script>

<template>
  <AlertDialog
    :open="open"
    @update:open="
      (val: boolean) => {
        if (!val && !pendingConfirm) emit('cancel');
        pendingConfirm = false;
      }
    "
  >
    <AlertDialogContent data-test="new-folder-dialog">
      <AlertDialogHeader>
        <AlertDialogTitle>New folder</AlertDialogTitle>
        <AlertDialogDescription>
          Enter a name for the new folder.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div class="py-2">
        <Label for="new-folder-input" class="sr-only">New folder name</Label>
        <Input
          id="new-folder-input"
          data-test="new-folder-input"
          v-model="name"
          type="text"
          autocomplete="off"
        />
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel data-test="new-folder-cancel">
          Cancel
        </AlertDialogCancel>
        <AlertDialogAction data-test="new-folder-confirm" @click="onConfirm">
          Create
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
