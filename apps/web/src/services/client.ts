import { ApiClient } from '@remote/api-client';
import { tokenStorage } from './token-storage';

const baseUrl = import.meta.env.VITE_API_URL || 'http://localhost:8787';

export const apiClient = new ApiClient({
  baseUrl,
  storage: tokenStorage,
});
