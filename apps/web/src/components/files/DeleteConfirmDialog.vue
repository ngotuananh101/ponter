<script setup lang="ts">
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

const props = defineProps<{
  open: boolean;
  name: string;
  isDirectory: boolean;
}>();
const emit = defineEmits<{
  (e: 'confirm', recursive: boolean): void;
  (e: 'cancel'): void;
}>();

function onDelete(): void {
  emit('confirm', props.isDirectory);
  emit('cancel');
}
</script>

<template>
  <AlertDialog :open="open">
    <AlertDialogContent data-test="delete-dialog">
      <AlertDialogHeader>
        <AlertDialogTitle>Delete {{ name }}?</AlertDialogTitle>
        <AlertDialogDescription>
          <span v-if="isDirectory">
            This is a directory. Deleting it removes its contents.
          </span>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel data-test="delete-cancel" @click="emit('cancel')">
          Cancel
        </AlertDialogCancel>
        <AlertDialogAction data-test="delete-confirm" @click="onDelete">
          {{ isDirectory ? 'Delete folder' : 'Delete' }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
