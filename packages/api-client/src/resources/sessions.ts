import type { HttpClient } from '../client';
import type { Session } from '@remote/shared';

export interface CreateSessionInput {
  deviceId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

export class SessionsResource {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<Session[]> {
    return await this.http.request<Session[]>('GET', '/api/sessions');
  }

  async create(input: CreateSessionInput): Promise<Session> {
    return await this.http.request<Session>('POST', '/api/sessions', {
      body: input,
    });
  }

  async get(id: string): Promise<Session> {
    return await this.http.request<Session>('GET', `/api/sessions/${id}`);
  }

  async terminate(id: string): Promise<{ success: boolean }> {
    return await this.http.request<{ success: boolean }>(
      'DELETE',
      `/api/sessions/${id}`,
    );
  }
}
