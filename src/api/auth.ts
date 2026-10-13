import { apiRequest } from './client';
import type { LoginData, LoginRequest } from './types';

/** POST /auth/login. Online only. 422 = bad credentials or inactive account. */
export async function login(credentials: LoginRequest): Promise<LoginData> {
  const response = await apiRequest<LoginData>('/auth/login', {
    method: 'POST',
    body: credentials,
    auth: false,
  });
  return response.data;
}
