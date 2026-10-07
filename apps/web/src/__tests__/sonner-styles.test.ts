import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// vue-sonner ships its stylesheet separately (`vue-sonner/style.css`) and does
// NOT inject it at runtime for a plain Vite SPA — only the Nuxt module pushes it
// into `nuxt.options.css`. Without this import the Toaster renders completely
// unstyled: no positioning, background, or rich-colors palette. The failure is
// invisible to component tests (happy-dom does not apply imported CSS), so the
// guard reads the app entry directly, the same way headers.test.ts pins
// public/_headers.
const main = readFileSync(resolve(__dirname, '../main.ts'), 'utf8');

describe('vue-sonner stylesheet is loaded', () => {
  it('main.ts imports vue-sonner/style.css', () => {
    expect(main).toMatch(/import\s+['"]vue-sonner\/style\.css['"]/);
  });
});
