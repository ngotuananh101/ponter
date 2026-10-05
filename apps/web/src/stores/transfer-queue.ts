import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import type { QueueItem, QueueItemStatus } from '@ponter/shared';

export interface EnqueuePayload {
  id: string;
  name: string;
  path: string;
  size: number;
  direction: 'upload' | 'download';
}

export const useTransferQueueStore = defineStore('transfer-queue', () => {
  const items = ref<QueueItem[]>([]);

  // Last progress update timestamp per item id, for rolling speed computation.
  const lastProgressAt = ref<Record<string, number>>({});

  const activeUploadId = computed<string | null>(() => {
    const item = items.value.find(
      (i) => i.direction === 'upload' && i.status === 'active',
    );
    return item ? item.id : null;
  });

  const activeDownloadId = computed<string | null>(() => {
    const item = items.value.find(
      (i) => i.direction === 'download' && i.status === 'active',
    );
    return item ? item.id : null;
  });

  function findItem(id: string): QueueItem | undefined {
    return items.value.find((i) => i.id === id);
  }

  function findItemInDirection(
    direction: 'upload' | 'download',
    status: QueueItemStatus,
  ): QueueItem | undefined {
    return items.value.find(
      (i) => i.direction === direction && i.status === status,
    );
  }

  /**
   * Promote the first queued item in `direction` (FIFO) to active, if the
   * concurrency gate for that direction is free. Returns the promoted item
   * id or null when no item was promoted.
   */
  function pump(direction: 'upload' | 'download'): string | null {
    const hasActive =
      direction === 'upload'
        ? activeUploadId.value !== null
        : activeDownloadId.value !== null;
    if (hasActive) return null;

    const queued = findItemInDirection(direction, 'queued');
    if (!queued) return null;

    queued.status = 'active';
    return queued.id;
  }

  function enqueue(payload: EnqueuePayload): QueueItem {
    const hasActive =
      payload.direction === 'upload'
        ? activeUploadId.value !== null
        : activeDownloadId.value !== null;

    const item: QueueItem = {
      id: payload.id,
      name: payload.name,
      path: payload.path,
      size: payload.size,
      bytesTransferred: 0,
      direction: payload.direction,
      // Concurrency gate: start active if the slot for this direction is free,
      // otherwise wait in the queue and be promoted when a slot frees up.
      status: hasActive ? 'queued' : 'active',
      speedBytesPerSec: 0,
      etaSeconds: null,
    };
    items.value.push(item);

    return item;
  }

  function pause(id: string): void {
    const item = findItem(id);
    if (!item) return;
    if (item.status === 'active') {
      item.status = 'paused';
      // Free the slot and attempt to promote the next queued item.
      pump(item.direction);
    }
  }

  function resume(id: string): void {
    const item = findItem(id);
    if (!item) return;
    if (item.status !== 'paused') return;

    const hasActive =
      item.direction === 'upload'
        ? activeUploadId.value !== null
        : activeDownloadId.value !== null;
    if (!hasActive) {
      item.status = 'active';
    } else {
      item.status = 'queued';
      pump(item.direction);
    }
  }

  function cancel(id: string, error?: string): void {
    const item = findItem(id);
    if (!item) return;
    const wasActive = item.status === 'active';
    item.status = 'cancelled';
    if (error) item.error = error;

    if (wasActive) {
      pump(item.direction);
    }
  }

  function markCompleted(id: string): void {
    const item = findItem(id);
    if (!item) return;
    const wasActive = item.status === 'active';
    item.status = 'completed';
    item.bytesTransferred = item.size;
    item.speedBytesPerSec = 0;
    item.etaSeconds = null;

    if (wasActive) {
      pump(item.direction);
    }
  }

  /**
   * Update progress for an item and maintain rolling speed + ETA.
   *
   * Rolling speed is bytes-per-second over the delta since the previous
   * progress update. ETA is derived from remaining bytes and the current
   * rolling speed. When speed is zero or the transfer is complete, ETA
   * is reported as null.
   */
  function updateProgress(
    id: string,
    bytesTransferred: number,
    now = Date.now(),
  ): void {
    const item = findItem(id);
    if (!item) return;

    // Clamp to valid bounds so callers cannot overshoot.
    const clamped = Math.max(0, Math.min(bytesTransferred, item.size));

    const prevBytes = item.bytesTransferred;
    const prevAt = lastProgressAt.value[id];
    const delta = clamped - prevBytes;

    let speed = 0;
    if (prevAt !== undefined && delta > 0) {
      const elapsedSec = (now - prevAt) / 1000;
      if (elapsedSec > 0) {
        speed = delta / elapsedSec;
      }
    }

    item.speedBytesPerSec = speed;
    item.bytesTransferred = clamped;
    lastProgressAt.value[id] = now;

    if (clamped >= item.size) {
      item.etaSeconds = null;
    } else if (speed > 0) {
      item.etaSeconds = Math.ceil((item.size - clamped) / speed);
    } else {
      item.etaSeconds = null;
    }
  }

  function remove(id: string): void {
    const idx = items.value.findIndex((i) => i.id === id);
    if (idx === -1) return;
    const item = items.value[idx];
    if (!item) return;
    const wasActive = item.status === 'active';
    items.value.splice(idx, 1);
    delete lastProgressAt.value[id];
    if (wasActive) {
      pump(item.direction);
    }
  }

  function clear(status?: QueueItemStatus): void {
    for (let i = items.value.length - 1; i >= 0; i--) {
      const item = items.value[i];
      if (!item) continue;
      if (!status || item.status === status) {
        const wasActive = item.status === 'active';
        items.value.splice(i, 1);
        delete lastProgressAt.value[item.id];
        if (wasActive) {
          // Pump synchronously to maintain invariants after removal.
          pump(item.direction);
        }
      }
    }
  }

  return {
    items,
    activeUploadId,
    activeDownloadId,
    enqueue,
    pause,
    resume,
    cancel,
    markCompleted,
    updateProgress,
    remove,
    clear,
  };
});
