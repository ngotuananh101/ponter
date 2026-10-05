import { describe, it, expect } from 'vitest';
import {
  BINARY_TYPE_DOWNLOAD_CHUNK,
  BINARY_TYPE_UPLOAD_CHUNK,
  BINARY_HEADER_LEN,
  type FilesPauseMessage,
  type FilesResumeRequest,
  type FilesMkdirRequest,
  type FilesErrorCode,
} from '../src/types/files';

describe('Week 11 Shared File Transfer Types', () => {
  it('exports binary frame constants', () => {
    expect(BINARY_TYPE_DOWNLOAD_CHUNK).toBe(0x01);
    expect(BINARY_TYPE_UPLOAD_CHUNK).toBe(0x02);
    expect(BINARY_HEADER_LEN).toBe(25);
  });

  it('validates pause and resume types structure', () => {
    const pause: FilesPauseMessage = { transferId: 't-1', direction: 'upload' };
    const resume: FilesResumeRequest = {
      transferId: 't-1',
      path: 'docs/file.bin',
      direction: 'upload',
      fromChunkIndex: 10,
    };
    expect(pause.transferId).toBe('t-1');
    expect(resume.fromChunkIndex).toBe(10);
  });

  it('validates mkdir request type structure', () => {
    const mkdir: FilesMkdirRequest = {
      requestId: 'r-1',
      dir: 'sub',
      name: 'nested',
    };
    expect(mkdir.name).toBe('nested');
  });

  it('includes new error codes in FilesErrorCode union', () => {
    const errors: FilesErrorCode[] = [
      'RESUME_INVALID',
      'DIR_NOT_EMPTY',
      'PERMISSION_DENIED',
      'QUEUE_FULL',
    ];
    expect(errors).toHaveLength(4);
  });
});
