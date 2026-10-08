import { expect } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';

/**
 * Wait for reactivity to settle after opening a dialog.
 * Imported from vitest to avoid re-export coupling.
 */
export async function waitForOpen(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await flushPromises();
    await nextTick();
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Query document.body for dialog content (Teleport renders there by default).
 */
export function queryBody(selector: string): HTMLElement | null {
  return document.querySelector(selector);
}

/**
 * Set value on a raw DOM input and trigger input + change events for v-model sync.
 */
export async function domSetValue(
  el: HTMLElement,
  value: string,
): Promise<void> {
  const input = el as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await nextTick();
  await new Promise((r) => setTimeout(r, 10));
}

/**
 * Click a raw DOM element.
 */
export async function domClick(el: HTMLElement): Promise<void> {
  el.click();
  await nextTick();
  await new Promise((r) => setTimeout(r, 10));
}

/**
 * Query document.body for a dialog element and assert it is non-null.
 * The `expect(el).not.toBeNull()` guard is INSIDE this helper so that every
 * caller still executes exactly one assertion, but the textual `expect` line
 * is de-duplicated across the many dialog tests.
 */
export function queryDialogAction<T extends HTMLElement = HTMLElement>(
  selector: string,
): T {
  const el = document.querySelector(selector) as T | null;
  expect(el).not.toBeNull();
  return el as T;
}
