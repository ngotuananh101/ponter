import { ApiClient } from '@ponter/api-client';
import { getApiBaseUrl } from '../config';
import { tokenStorage } from './token-storage';

export const apiClient = new ApiClient({
  baseUrl: getApiBaseUrl(),
  storage: tokenStorage,
});
