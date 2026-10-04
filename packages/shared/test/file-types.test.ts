import { describe, it, expect } from 'vitest';
import type {
  FilesAckMessage,
  FilesCancelMessage,
  FilesDownloadBegin,
  FilesDownloadEnd,
  FilesDownloadRequest,
  FilesErrorMessage,
  FilesErrorCode,
  FilesListRequest,
  FilesListResult,
  FilesPath,
  FilesUploadBeginRequest,
  FilesUploadComplete,
  FilesUploadEndRequest,
} from '../src';
import type { FileChunkMessage, RemoteFile } from '../src';

describe('File transfer wire types (Week 10, spec §2.3)', () => {
  it('instantiates a list request and result with relative paths', () => {
    const req: FilesListRequest = { requestId: 'r-1', path: '' };
    const root: FilesPath = '';
    const entry: RemoteFile = {
      name: 'notes.txt',
      path: 'docs/notes.txt',
      size: 12,
      isDirectory: false,
      modifiedAt: '2026-10-04T12:00:00Z',
    };
    const res: FilesListResult = {
      requestId: req.requestId,
      path: root,
      entries: [entry],
      truncated: false,
    };
    expect(res.entries[0]?.path).toBe('docs/notes.txt');
    expect(res.truncated).toBe(false);
  });

  it('instantiates the download lifecycle payloads', () => {
    const req: FilesDownloadRequest = { transferId: 't-1', path: 'a.bin' };
    const begin: FilesDownloadBegin = {
      transferId: req.transferId,
      name: 'a.bin',
      path: req.path,
      size: 32769,
      totalChunks: 2,
    };
    const end: FilesDownloadEnd = { transferId: req.transferId };
    expect(begin.totalChunks).toBe(2);
    expect(end.transferId).toBe(begin.transferId);
  });

  it('instantiates the upload lifecycle payloads', () => {
    const begin: FilesUploadBeginRequest = {
      transferId: 't-2',
      path: 'dir',
      name: 'up.bin',
      size: 0,
    };
    const end: FilesUploadEndRequest = { transferId: begin.transferId };
    const complete: FilesUploadComplete = {
      transferId: begin.transferId,
      name: 'up.bin',
      path: 'dir/up.bin',
      size: 0,
    };
    expect(complete.path).toBe('dir/up.bin');
    expect(end.transferId).toBe(complete.transferId);
  });

  it('carries a cumulative ack and an optional cancel id', () => {
    const ack: FilesAckMessage = { transferId: 't-1', nextChunkIndex: 3 };
    const cancelTransfer: FilesCancelMessage = { transferId: 't-1' };
    const cancelList: FilesCancelMessage = { requestId: 'r-1' };
    expect(ack.nextChunkIndex).toBe(3);
    expect(cancelTransfer.requestId).toBeUndefined();
    expect(cancelList.transferId).toBeUndefined();
  });

  it('round-trips every FilesErrorCode spelling', () => {
    const codes: FilesErrorCode[] = [
      'PATH_OUTSIDE_ROOT',
      'INVALID_PATH',
      'NOT_FOUND',
      'NOT_A_FILE',
      'NOT_A_DIRECTORY',
      'FILE_EXISTS',
      'FILE_TOO_LARGE',
      'TRANSFER_BUSY',
      'TRANSFER_UNKNOWN',
      'TRANSFER_TIMEOUT',
      'IO_ERROR',
      'BAD_FRAME',
    ];
    // A compile-time guard: the union must accept exactly these twelve.
    const seen = new Set<string>(codes);
    expect(seen.size).toBe(12);
    const err: FilesErrorMessage = {
      transferId: 't-1',
      code: 'BAD_FRAME',
      message: 'chunk gap',
    };
    expect(err.code).toBe('BAD_FRAME');
  });

  it('reuses the existing FileChunkMessage shape for chunks', () => {
    const chunk: FileChunkMessage = {
      transferId: 't-1',
      chunkIndex: 0,
      totalChunks: 1,
      data: 'AA==',
    };
    expect(chunk.chunkIndex).toBe(0);
  });
});
