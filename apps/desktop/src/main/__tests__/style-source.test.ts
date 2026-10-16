// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Tailwind source discovery', () => {
  it('scans shared components and renderer-local Vue files', () => {
    const css = readFileSync(
      resolve(process.cwd(), 'src/renderer/style.css'),
      'utf8',
    );

    expect(css).toContain('@source "../../../../packages/ui-components/src";');
    expect(css).toContain('@source "./views";');
    expect(css).toContain('@source "./components";');
    expect(css).toContain('@source "./App.vue";');
  });
});
