import { expect, it } from 'vitest';
// apps/agent/test/files/action-result.test.ts
import { FILES_ERROR_CODES, type FilesErrorCode } from '@ponter/shared';
import { FileClient } from '@ponter/file-core';
import { makeFakeManager } from '@ponter/file-core/test/helpers';

const CODES = Object.keys(FILES_ERROR_CODES) as FilesErrorCode[];

it.each(CODES.filter((c) => c !== 'BAD_FRAME'))(
  'the browser accepts the port-emitted %s',
  async (code) => {
    const fake = makeFakeManager();
    const client = new FileClient('ag-1', fake.manager);
    const promise = client.mkdir('docs', 'new');
    const frame = fake.sent.at(-1);
    fake.emit('files-action-result', {
      requestId: frame?.payload.requestId,
      action: 'mkdir',
      success: false,
      error: code, // the BARE code, as the port emits it
    });
    await expect(promise).rejects.toMatchObject({ code }); // not BAD_FRAME
  },
);

// `BAD_FRAME` is both a member of the 16 and the client's fallback
// (`client.ts:566-571`), so the iteration above CANNOT discriminate it:
// accepted and defaulted both reject with code === 'BAD_FRAME'. Measured —
// an array with BAD_FRAME removed still passes all 16 (probe
// ../b12g-n7-vacuity/, mutant B). So the fallback is pinned separately:
it('an unknown code degrades to BAD_FRAME', async () => {
  const fake = makeFakeManager();
  const client = new FileClient('ag-1', fake.manager);
  const promise = client.mkdir('docs', 'new');
  const frame = fake.sent.at(-1);
  fake.emit('files-action-result', {
    requestId: frame?.payload.requestId,
    action: 'mkdir',
    success: false,
    error: 'NOT_A_CODE',
  });
  await expect(promise).rejects.toMatchObject({ code: 'BAD_FRAME' });
});
