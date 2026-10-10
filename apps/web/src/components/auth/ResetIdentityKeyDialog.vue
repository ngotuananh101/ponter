<script setup lang="ts">
import { ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { KeyRound } from '@lucide/vue';
import { toast } from 'vue-sonner';

defineProps<{ open: boolean }>();
const emit = defineEmits<{
  (e: 'update:open', value: boolean): void;
  (e: 'success'): void;
}>();

const authStore = useAuthStore();
const password = ref('');
const loading = ref(false);
const error = ref<string | null>(null);

async function handleSubmit() {
  loading.value = true;
  error.value = null;
  try {
    await authStore.resetSigningKey(password.value);
    toast.success('Identity key reset successfully');
    password.value = '';
    error.value = null;
    emit('success');
    emit('update:open', false);
  } catch (err: unknown) {
    error.value =
      err instanceof Error ? err.message : 'Failed to reset identity key';
  } finally {
    loading.value = false;
  }
}

function handleClose() {
  password.value = '';
  error.value = null;
}
</script>

<template>
  <Dialog :open="open" @update:open="handleClose">
    <DialogContent data-test="reset-identity-key-dialog">
      <form @submit.prevent="handleSubmit">
        <DialogHeader>
          <DialogTitle>Reset Identity Key</DialogTitle>
          <DialogDescription>
            Re-keying generates a fresh Ed25519 identity key for P2P connection
            signing on this device and requires account password verification.
          </DialogDescription>
        </DialogHeader>

        <Alert
          v-if="error"
          variant="destructive"
          data-test="reset-identity-key-error"
        >
          <AlertDescription>{{ error }}</AlertDescription>
        </Alert>

        <div class="my-4 space-y-2">
          <Label for="reset-identity-key-password">Account Password</Label>
          <Input
            id="reset-identity-key-password"
            type="password"
            required
            placeholder="Enter your current password"
            v-model="password"
            data-test="reset-identity-key-password"
            :disabled="loading"
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            :disabled="loading"
            data-test="reset-identity-key-cancel"
            @click="handleClose"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            :disabled="loading || !password"
            data-test="reset-identity-key-submit"
          >
            <KeyRound v-if="!loading" class="w-4 h-4 mr-2" />
            {{ loading ? 'Resetting…' : 'Reset Key' }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
