import { WebSocket } from 'ws';

/** Resolve after `ms` milliseconds. */
export function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll `fn` every 10ms until it returns a defined value, or throw on timeout. */
export async function waitFor<T>(
  fn: () => T | undefined,
  timeoutMs = 1000,
): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = fn();
    if (result !== undefined) return result;
    await wait(10);
  }
  throw new Error('Timed out waiting for condition');
}

/**
 * Open an agent WebSocket on an ephemeral server and collect every frame the
 * server pushes. The message handler is registered before waiting for `open`
 * so a frame pushed immediately on connect is never missed. Shared by the
 * signaling, ICE, and WS2 identity test files so the connect-and-collect
 * boilerplate lives in exactly one place.
 */
export async function connectAgentCollect(
  port: number,
  credential: string,
): Promise<{ ws: WebSocket; received: string[] }> {
  const ws = new WebSocket(`ws://localhost:${port}/api/ws/agent`, {
    headers: { Authorization: `Bearer ${credential}` },
  });
  const received: string[] = [];
  ws.on('message', (data: Buffer) => {
    received.push(data.toString());
  });
  await waitFor(() => (ws.readyState === WebSocket.OPEN ? true : undefined));
  return { ws, received };
}
