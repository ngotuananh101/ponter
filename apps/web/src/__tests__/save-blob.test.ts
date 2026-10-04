import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { saveBlob } from '@/lib/save-blob';

/**
 * Exercises the real `saveBlob` path (spec §7.1) — object-URL creation, the
 * synthetic `<a download>` click, `rel="noopener"`, and revocation in the
 * `finally`. happy-dom does NOT implement URL.createObjectURL/revokeObjectURL,
 * so stub them and assert the real module's behavior directly.
 */
describe('saveBlob (spec §7.1)', () => {
  const blobUrl = 'blob:http://localhost/fake-blob-url';
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let appended: HTMLAnchorElement[] = [];

  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  beforeEach(() => {
    appended = [];
    createObjectURL = vi.fn(() => blobUrl);
    revokeObjectURL = vi.fn();
    URL.createObjectURL = createObjectURL as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as typeof URL.revokeObjectURL;

    // Capture each appended anchor and stub its click() so we can assert it.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function () {},
    );
    vi.spyOn(document.body, 'appendChild').mockImplementation(
      (node: Node): Node => {
        if (node instanceof HTMLAnchorElement) appended.push(node);
        return node;
      },
    );
    vi.spyOn(document.body, 'removeChild').mockImplementation(
      (_node: Node): Node => {
        return document.createElement('span') as unknown as Node;
      },
    );
  });

  afterEach(() => {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    vi.restoreAllMocks();
  });

  it('creates an object URL from a Blob of the input bytes, clicks a download link, and revokes', () => {
    const bytes = new Uint8Array([10, 20, 30, 40]);

    saveBlob('report.bin', bytes);

    // object URL created once
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blobArg = createObjectURL.mock.calls[0]![0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);

    // revoke called once with the stubbed blob URL — the finally branch ran
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(blobUrl);

    // exactly one synthetic anchor appended and clicked
    expect(appended).toHaveLength(1);
    expect(appended[0]!.click).toHaveBeenCalledTimes(1);
  });

  it('builds the synthetic anchor with the blob URL, download name, rel="noopener"', () => {
    const bytes = new Uint8Array([1]);

    saveBlob('payload.dat', bytes);

    expect(appended).toHaveLength(1);
    const anchor = appended[0]!;
    expect(anchor.href).toBe(blobUrl);
    expect(anchor.download).toBe('payload.dat');
    expect(anchor.rel).toBe('noopener');
  });

  it('revokes the blob URL even if an error is thrown inside the try', () => {
    const bytes = new Uint8Array([1]);

    // Force a failure inside the try block to prove the finally still revokes.
    vi.spyOn(document, 'createElement').mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => saveBlob('x.bin', bytes)).toThrow('boom');
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith(blobUrl);
  });
});
