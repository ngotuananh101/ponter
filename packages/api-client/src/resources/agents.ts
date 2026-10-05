import type { HttpClient } from '../client';
import type { Agent } from '@ponter/shared';

export interface CreateAgentInput {
  id: string;
  hostname?: string;
  platform?: string;
  osVersion?: string;
  agentVersion?: string;
  publicKey?: string;
  capabilities?: string[];
}

export interface CreateAgentResult {
  agent: Agent;
  credential: string;
}

/**
 * The mutable subset of an agent's metadata.
 *
 * Identity and lifecycle fields (`id`, `publicKey`, `userId`, `isOnline`,
 * `lastHeartbeat`, `createdAt`) are deliberately absent: the server rejects
 * them, and omitting them here makes that a compile-time error at every call
 * site rather than a 400 at runtime.
 */
export interface UpdateAgentInput {
  hostname?: string | null;
  platform?: string | null;
  osVersion?: string | null;
  agentVersion?: string | null;
  capabilities?: string[] | null;
}

export class AgentsResource {
  constructor(private readonly http: HttpClient) {}

  async list(): Promise<Agent[]> {
    return await this.http.request<Agent[]>('GET', '/api/agents');
  }

  async create(input: CreateAgentInput): Promise<CreateAgentResult> {
    return await this.http.request<CreateAgentResult>('POST', '/api/agents', {
      body: input,
    });
  }

  async get(id: string): Promise<Agent> {
    return await this.http.request<Agent>('GET', `/api/agents/${id}`);
  }

  async update(id: string, input: UpdateAgentInput): Promise<Agent> {
    return await this.http.request<Agent>('PATCH', `/api/agents/${id}`, {
      body: input,
    });
  }

  async delete(id: string): Promise<{ success: boolean }> {
    return await this.http.request<{ success: boolean }>(
      'DELETE',
      `/api/agents/${id}`,
    );
  }
}
