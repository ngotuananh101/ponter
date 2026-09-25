import type { HttpClient } from '../client';
import type { Device } from '@remote/shared';

export interface CreateDeviceInput {
  fingerprint: string;
  deviceName?: string;
  deviceType: 'desktop' | 'mobile' | 'web';
}

export class DevicesResource {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<Device[]> {
    return await this.http.request<Device[]>('GET', '/api/devices');
  }

  async create(input: CreateDeviceInput): Promise<Device> {
    return await this.http.request<Device>('POST', '/api/devices', {
      body: input,
    });
  }

  async remove(id: string): Promise<{ success: boolean }> {
    return await this.http.request<{ success: boolean }>('DELETE', `/api/devices/${id}`);
  }
}
