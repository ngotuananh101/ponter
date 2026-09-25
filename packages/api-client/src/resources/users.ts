import type { HttpClient } from '../client';
import type { User } from '@remote/shared';

export class UsersResource {
  constructor(private readonly http: HttpClient) {}

  async me(): Promise<{ user: User }> {
    return await this.http.request<{ user: User }>('GET', '/api/users/me');
  }
}
