import type { HttpClient } from '../client';
import type {
  SystemStats,
  SystemSettings,
  User,
  UserRole,
  ApprovalStatus,
} from '@ponter/shared';

export interface GetUsersQuery {
  status?: ApprovalStatus | 'all';
  search?: string;
  page?: number;
  limit?: number;
}

export interface UpdateUserPayload {
  approvalStatus?: ApprovalStatus;
  isActive?: boolean;
  role?: UserRole;
}

export class AdminResource {
  constructor(private readonly http: HttpClient) {}

  async getStats(): Promise<SystemStats> {
    return this.http.request<SystemStats>('GET', '/api/admin/stats', {
      auth: true,
    });
  }

  async getUsers(
    params: GetUsersQuery = {},
  ): Promise<{ users: User[]; total: number }> {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.search) query.set('search', params.search);
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    const qs = query.toString();
    const path = qs ? `/api/admin/users?${qs}` : '/api/admin/users';
    return this.http.request<{ users: User[]; total: number }>('GET', path, {
      auth: true,
    });
  }

  async updateUser(
    id: string,
    payload: UpdateUserPayload,
  ): Promise<{ user: User }> {
    return this.http.request<{ user: User }>(
      'PATCH',
      `/api/admin/users/${id}`,
      {
        body: payload,
        auth: true,
      },
    );
  }

  async getSettings(): Promise<SystemSettings> {
    return this.http.request<SystemSettings>('GET', '/api/admin/settings', {
      auth: true,
    });
  }

  async updateSettings(
    settings: Partial<SystemSettings>,
  ): Promise<{ settings: SystemSettings }> {
    return this.http.request<{ settings: SystemSettings }>(
      'PUT',
      '/api/admin/settings',
      {
        body: settings,
        auth: true,
      },
    );
  }
}
