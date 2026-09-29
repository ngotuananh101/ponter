import type { HttpClient } from '../client';
import type { IceServerConfig } from '@remote/shared';

export interface IceServersResponse {
  iceServers?: IceServerConfig[];
}

export class WebrtcResource {
  constructor(private readonly http: HttpClient) {}

  /**
   * Fetch the ICE server list for the authenticated user.
   *
   * The server mints short-lived RFC 5766 HMAC-SHA1 TURN credentials on demand,
   * so this must be called per connection rather than cached long-term.
   */
  async getIceServers(): Promise<IceServerConfig[]> {
    const response = await this.http.request<IceServersResponse>(
      'GET',
      '/api/webrtc/ice-servers',
    );
    return response.iceServers ?? [];
  }
}
