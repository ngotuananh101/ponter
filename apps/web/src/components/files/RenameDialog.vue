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
  emit('cancel');
}
</script>

<template>
  <AlertDialog :open="open">
    <AlertDialogContent data-test="rename-dialog">
      <AlertDialogHeader>
        <AlertDialogTitle>Rename</AlertDialogTitle>
        <AlertDialogDescription>
          Enter the new name for this item.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div class="py-2">
        <Label for="rename-input" class="sr-only">Rename</Label>
        <Input
          id="rename-input"
          data-test="rename-input"
          v-model="name"
          type="text"
          autocomplete="off"
        />
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel data-test="rename-cancel" @click="emit('cancel')">
          Cancel
        </AlertDialogCancel>
        <AlertDialogAction data-test="rename-confirm" @click="onConfirm">
          OK
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
