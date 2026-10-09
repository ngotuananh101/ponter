export * from './terminal.js';
export type {
  DeviceType,
  User,
  Device,
  Agent,
  UserRole,
  ApprovalStatus,
  SystemStats,
  SystemSettings,
} from './user.js';

export type { SessionStatus, Session } from './session.js';

export type {
  IceServerConfig,
  WebRTCChannelType,
  DataChannelMessage,
} from './webrtc.js';

export type {
  DesktopSourceInfo,
  DesktopStats,
  DesktopInput,
  DesktopSourcesPayload,
  DesktopShape,
  DesktopCursorPayload,
  KeyModifiers,
} from './desktop.js';

export {
  BINARY_TYPE_DOWNLOAD_CHUNK,
  BINARY_TYPE_UPLOAD_CHUNK,
  BINARY_HEADER_LEN,
} from './files.js';
export type {
  TransferDirection,
  FileTransferStatus,
  RemoteFile,
  FileTransfer,
  FileChunkMessage,
  FilesPath,
  FilesListRequest,
  FilesListResult,
  FilesDownloadRequest,
  FilesDownloadBegin,
  FilesDownloadEnd,
  FilesUploadBeginRequest,
  FilesUploadEndRequest,
  FilesUploadComplete,
  FilesAckMessage,
  FilesCancelMessage,
  FilesErrorCode,
  FilesErrorMessage,
  FilesPauseMessage,
  FilesPauseAckMessage,
  FilesResumeRequest,
  FilesResumeAckMessage,
  FilesMkdirRequest,
  FilesDeleteRequest,
  FilesRenameRequest,
  FilesActionResult,
  QueueItem,
  QueueItemStatus,
  QueueStatus,
} from './files.js';

export type {
  LoginRequest,
  AuthTokens,
  LoginResponse,
  RegisterRequest,
  RegisterResponse,
} from './auth.js';

export type {
  SignalOffer,
  SignalAnswer,
  IdentityProof,
  IceCandidateSignal,
  SignalMessage,
  AgentErrorCode,
  AgentSocketMessage,
  BrowserErrorCode,
  BrowserMessageInit,
  BrowserSocketMessage,
} from './signaling.js';

// `parseBrowserMessage` is a function, so it is re-exported by value rather
// than through the `export type` block above.
export { parseBrowserMessage } from './signaling.js';

export {
  PROOF_VERSION,
  canonicalProofMessage,
  normalizeFingerprint,
  parseSdpFingerprint,
  USER_IDENTITY_PROOF_PREFIX,
  canonicalUserIdentityMessage,
} from './identity-proof.js';
export type { PeerRole, CanonicalProofInput } from './identity-proof.js';

export {
  WS1_KEY_VERSION,
  WS1_TERMINAL_INFO,
  canonicalKeyBinding,
} from './e2ee.js';
export type { E2eeKeyBinding } from './e2ee.js';
