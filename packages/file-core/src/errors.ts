import type { FilesErrorCode } from '@ponter/shared';

/**
 * Client-side codes: every wire code (spec §2.3) plus one synthetic code that
 * never appears on the wire — 'CANCELLED', raised locally by cancel()/dispose().
 */
export type FileClientErrorCode = FilesErrorCode | 'CANCELLED';

/** Error thrown/rejected by FileClient operations. */
export class FilesError extends Error {
  constructor(
    public readonly code: FileClientErrorCode,
    message: string,
    public readonly transferId?: string,
  ) {
    super(message);
    this.name = 'FilesError';
  }
}
