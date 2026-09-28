import { RingBuffer } from './buffer';
import type { SessionState } from './types';

export class TerminalSession {
  public state: SessionState = 'connecting';
  public exitCode?: number;
  public readonly buffer = new RingBuffer(64 * 1024);

  private readonly dataListeners: Array<(data: Uint8Array) => void> = [];
  private readonly exitListeners: Array<(code?: number) => void> = [];
  private readonly stateListeners: Array<(state: SessionState) => void> = [];

  constructor(
    public readonly id: string,
    public cols: number = 80,
    public rows: number = 24,
    private readonly sendInputFn: (data: Uint8Array | string) => void,
    private readonly resizeFn: (cols: number, rows: number) => void,
    private readonly closeFn: () => void,
  ) {}

  write(data: Uint8Array | string): void {
    if (this.state !== 'active' && this.state !== 'connecting') return;
    this.sendInputFn(data);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.resizeFn(cols, rows);
  }

  close(): void {
    if (this.state === 'closed') return;
    this.setState('closed');
    this.closeFn();
  }

  receiveOutput(chunk: Uint8Array): void {
    this.buffer.push(chunk);
    if (this.state === 'connecting') {
      this.setState('active');
    }
    for (const listener of [...this.dataListeners]) {
      listener(chunk);
    }
  }

  markExited(exitCode?: number): void {
    this.exitCode = exitCode;
    this.setState('exited');
    for (const listener of [...this.exitListeners]) {
      listener(exitCode);
    }
  }

  onData(cb: (data: Uint8Array) => void): () => void {
    this.dataListeners.push(cb);
    return () => {
      const idx = this.dataListeners.indexOf(cb);
      if (idx >= 0) this.dataListeners.splice(idx, 1);
    };
  }

  onExit(cb: (code?: number) => void): () => void {
    this.exitListeners.push(cb);
    return () => {
      const idx = this.exitListeners.indexOf(cb);
      if (idx >= 0) this.exitListeners.splice(idx, 1);
    };
  }

  onStateChange(cb: (state: SessionState) => void): () => void {
    this.stateListeners.push(cb);
    return () => {
      const idx = this.stateListeners.indexOf(cb);
      if (idx >= 0) this.stateListeners.splice(idx, 1);
    };
  }

  private setState(newState: SessionState): void {
    if (this.state === newState) return;
    this.state = newState;
    for (const listener of [...this.stateListeners]) {
      listener(newState);
    }
  }
}
