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
