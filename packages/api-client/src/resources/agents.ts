import type { HttpClient } from '../client';
import type { Agent } from '@remote/shared';

export interface CreateAgentInput {
  id: string;
  hostname?: string;
  platform?: string;
  osVersion?: string;
  agentVersion?: string;
  publicKey: string;
}

export class AgentsResource {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<Agent[]> {
    return await this.http.request<Agent[]>('GET', '/api/agents');
  }

  async create(input: CreateAgentInput): Promise<Agent> {
    return await this.http.request<Agent>('POST', '/api/agents', {
      body: input,
    });
  }

  async get(id: string): Promise<Agent> {
    return await this.http.request<Agent>('GET', `/api/agents/${id}`);
  }
}
