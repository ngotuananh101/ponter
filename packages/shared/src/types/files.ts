export type TransferDirection = 'upload' | 'download';

export type FileTransferStatus =
  'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface RemoteFile {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
  modifiedAt: string;
  mode?: number;
}

export interface FileTransfer {
  id: string;
  sessionId: string;
  userId: string;
  fileName: string;
  fileSize: number;
  fileHash: string | null;
  direction: TransferDirection;
  status: FileTransferStatus;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface FileChunkMessage {
  transferId: string;
  chunkIndex: number;
  totalChunks: number;
  data: string; // base64 encoded
}

/** Every wire path is POSIX-relative to the configured root; '' means the root itself. */
export type FilesPath = string;

export interface FilesListRequest {
  requestId: string;
  path: FilesPath;
}

export interface FilesListResult {
  requestId: string;
  path: FilesPath;
  entries: RemoteFile[]; // RemoteFile.path is the entry's full relative path
  truncated: boolean; // true when the directory exceeded MAX_LIST_ENTRIES
}

export interface FilesDownloadRequest {
  transferId: string;
  path: FilesPath; // must name a file
}

export interface FilesDownloadBegin {
  transferId: string;
  name: string; // basename
  path: FilesPath;
  size: number; // bytes
  totalChunks: number; // ceil(size / FILE_CHUNK_BYTES); 0 for an empty file
}

export interface FilesDownloadEnd {
  transferId: string;
}

export interface FilesUploadBeginRequest {
  transferId: string;
  path: FilesPath; // target DIRECTORY ('' = root); must exist
  name: string; // single path component; target = path + '/' + name
  size: number; // bytes, declared by the browser
}

export interface FilesUploadEndRequest {
  transferId: string;
}

export interface FilesUploadComplete {
  transferId: string;
  name: string;
  path: FilesPath; // full relative path of the written file
  size: number;
}

/** Cumulative flow-control ack, used in both directions. */
export interface FilesAckMessage {
  transferId: string;
  /** Count of CONTIGUOUS chunks received so far (0 before the first chunk). */
  nextChunkIndex: number;
}

export interface FilesCancelMessage {
  requestId?: string; // cancel a pending list
  transferId?: string; // cancel a transfer
}

export type FilesErrorCode =
  | 'PATH_OUTSIDE_ROOT'
  | 'INVALID_PATH'
  | 'NOT_FOUND'
  | 'NOT_A_FILE'
  | 'NOT_A_DIRECTORY'
  | 'FILE_EXISTS'
  | 'FILE_TOO_LARGE'
  | 'TRANSFER_BUSY'
  | 'TRANSFER_UNKNOWN'
  | 'TRANSFER_TIMEOUT'
  | 'IO_ERROR'
  | 'BAD_FRAME';

export interface FilesErrorMessage {
  requestId?: string; // set when the failure answers a list request
  transferId?: string; // set when the failure belongs to a transfer
  code: FilesErrorCode;
  message: string; // human-readable, never parsed
}
