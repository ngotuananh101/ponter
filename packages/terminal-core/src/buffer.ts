export class RingBuffer {
  private buffer: Uint8Array;
  private size = 0;
  private head = 0;

  constructor(public readonly capacity: number = 64 * 1024) {
    this.buffer = new Uint8Array(capacity);
  }

  push(chunk: Uint8Array): void {
    if (chunk.length >= this.capacity) {
      this.buffer.set(chunk.subarray(chunk.length - this.capacity));
      this.head = 0;
      this.size = this.capacity;
      return;
    }

    for (let i = 0; i < chunk.length; i++) {
      this.buffer[(this.head + this.size) % this.capacity] = chunk[i]!
      if (this.size < this.capacity) {
        this.size++;
      } else {
        this.head = (this.head + 1) % this.capacity;
      }
    }
  }

  getAll(): Uint8Array {
    const out = new Uint8Array(this.size);
    for (let i = 0; i < this.size; i++) {
      out[i] = this.buffer[(this.head + i) % this.capacity]!
    }
    return out;
  }

  clear(): void {
    this.size = 0;
    this.head = 0;
  }
}
