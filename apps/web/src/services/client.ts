import { createApiClient } from '@ponter/api-client';
import { getApiBaseUrl } from '../config';
import { tokenStorage } from './token-storage';

export const apiClient = createApiClient({
  baseUrl: getApiBaseUrl(),
  storage: tokenStorage,
});
