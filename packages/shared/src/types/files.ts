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
  | 'BAD_FRAME'
  | 'RESUME_INVALID'
  | 'DIR_NOT_EMPTY'
  | 'PERMISSION_DENIED'
  | 'QUEUE_FULL';

// --- Binary frame constants (ADR-36) ---

/** Binary frame type for a download chunk (Agent -> Browser). */
export const BINARY_TYPE_DOWNLOAD_CHUNK = 0x01;
/** Binary frame type for an upload chunk (Browser -> Agent). */
export const BINARY_TYPE_UPLOAD_CHUNK = 0x02;
/** Total length in bytes of a binary chunk frame header: type(1) + transferId(16) + chunkIndex(8). */
export const BINARY_HEADER_LEN = 25;

// --- Pause & Resume ---

export interface FilesPauseMessage {
  transferId: string;
  direction: 'download' | 'upload';
}

export interface FilesPauseAckMessage {
  transferId: string;
  ackedChunkIndex: number;
  bytesTransferred: number;
}

export interface FilesResumeRequest {
  transferId: string;
  path: FilesPath;
  direction: 'download' | 'upload';
  fromChunkIndex: number;
}

export interface FilesResumeAckMessage {
  transferId: string;
  approved: boolean;
  fromChunkIndex: number;
  reason?: string;
}

// --- Directory Operations ---

export interface FilesMkdirRequest {
  requestId: string;
  dir: FilesPath;
  name: string;
}

export interface FilesDeleteRequest {
  requestId: string;
  path: FilesPath;
  recursive?: boolean;
}

export interface FilesRenameRequest {
  requestId: string;
  oldPath: FilesPath;
  newPath: FilesPath;
}

export interface FilesActionResult {
  requestId: string;
  action: 'mkdir' | 'delete' | 'rename';
  success: boolean;
  error?: string;
}

// --- Transfer Queue ---

export type QueueItemStatus =
  'queued' | 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';

export interface QueueItem {
  id: string;
  name: string;
  path: string;
  size: number;
  bytesTransferred: number;
  direction: 'upload' | 'download';
  status: QueueItemStatus;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  error?: string;
}

export interface QueueStatus {
  activeUpload: string | null;
  activeDownload: string | null;
  items: QueueItem[];
}

export interface FilesErrorMessage {
  requestId?: string; // set when the failure answers a list request
  transferId?: string; // set when the failure belongs to a transfer
  code: FilesErrorCode;
  message: string; // human-readable, never parsed
}
