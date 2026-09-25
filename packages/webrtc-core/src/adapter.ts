import type { IceServerConfig } from '@remote/shared';
import { BrowserAdapter } from './adapters/browser';

export function createBrowserAdapter(config?: { iceServers?: IceServerConfig[] }): BrowserAdapter {
  return new BrowserAdapter(config);
}
