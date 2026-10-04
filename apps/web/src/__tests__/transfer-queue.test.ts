import { describe, it, expect, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useTransferQueueStore } from '../stores/transfer-queue';

describe('Transfer Queue Store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('enqueues transfers and starts exactly one active upload', () => {
    const store = useTransferQueueStore();
    store.enqueue({ id: 't-1', name: 'f1.bin', path: 'f1.bin', size: 100, direction: 'upload' });
    store.enqueue({ id: 't-2', name: 'f2.bin', path: 'f2.bin', size: 200, direction: 'upload' });

    expect(store.items).toHaveLength(2);
    expect(store.activeUploadId).toBe('t-1');
    expect(store.items.find(i => i.id === 't-1')?.status).toBe('active');
    expect(store.items.find(i => i.id === 't-2')?.status).toBe('queued');
  });

  it('dequeues next upload when active upload completes', () => {
    const store = useTransferQueueStore();
    store.enqueue({ id: 't-1', name: 'f1.bin', path: 'f1.bin', size: 100, direction: 'upload' });
    store.enqueue({ id: 't-2', name: 'f2.bin', path: 'f2.bin', size: 200, direction: 'upload' });

    store.markCompleted('t-1');
    expect(store.activeUploadId).toBe('t-2');
    expect(store.items.find(i => i.id === 't-2')?.status).toBe('active');
  });

  it('enqueues a 20-file drop batch with exactly one active upload (Review Focus #5)', () => {
    const store = useTransferQueueStore();
    for (let i = 0; i < 20; i++) {
      store.enqueue({ id: `t-${i}`, name: `f${i}.bin`, path: `f${i}.bin`, size: 100, direction: 'upload' });
    }

    expect(store.items).toHaveLength(20);
    expect(store.items.filter(i => i.status === 'active')).toHaveLength(1);
    expect(store.activeUploadId).toBe('t-0');
    expect(store.items.filter(i => i.status === 'queued')).toHaveLength(19);
  });
});
