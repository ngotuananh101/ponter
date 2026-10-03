export * from './terminal.js';
export type { DeviceType, User, Device, Agent } from './user.js';

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
  KeyModifiers,
} from './desktop.js';

export type {
  TransferDirection,
  FileTransferStatus,
  RemoteFile,
  FileTransfer,
  FileChunkMessage,
} from './files.js';

export type {
  LoginRequest,
  AuthTokens,
  LoginResponse,
  RegisterRequest,
} from './auth.js';

export type {
  SignalOffer,
  SignalAnswer,
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
