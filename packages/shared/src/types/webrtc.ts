export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type WebRTCChannelType = 'terminal' | 'desktop' | 'files' | 'control';

export interface DataChannelMessage<T = unknown> {
  type: string;
  channel: WebRTCChannelType;
  payload: T;
  timestamp: number;
}
