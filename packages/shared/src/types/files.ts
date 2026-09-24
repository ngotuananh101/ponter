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
