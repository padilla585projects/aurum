/**
 * Sesión del usuario en el frontend.
 *
 * Sustituye al esquema anterior, en el que la clave del backend se guardaba en
 * localStorage y servía de credencial única para todo el mundo.
 */

import { ApiError, apiFetch, isNative, setNativeToken } from './api';

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  role: 'owner' | 'user';
  status: 'active' | 'suspended';
}

export interface AuthConfig {
  googleEnabled: boolean;
  passwordEnabled: boolean;
  needsBootstrap: boolean;
  openRegistration: boolean;
}

interface LoginPayload {
  user: SessionUser;
  expiresAt: number;
  token?: string;
}

export async function fetchAuthConfig(): Promise<AuthConfig> {
  return apiFetch<AuthConfig>('/api/auth/config');
}

/** Usuario actual, o null si no hay sesión válida. */
export async function fetchMe(): Promise<SessionUser | null> {
  try {
    const { user } = await apiFetch<{ user: SessionUser }>('/api/auth/me');
    return user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

function storeToken(payload: LoginPayload): SessionUser {
  // Solo la APK recibe el token; en web queda en la cookie httpOnly.
  if (isNative && payload.token) setNativeToken(payload.token);
  return payload.user;
}

export async function login(email: string, password: string): Promise<SessionUser> {
  const payload = await apiFetch<LoginPayload>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  return storeToken(payload);
}

export async function register(params: {
  email: string;
  password: string;
  name?: string;
  invite?: string;
  bootstrapSecret?: string;
}): Promise<SessionUser> {
  const payload = await apiFetch<LoginPayload>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(params),
  });
  return storeToken(payload);
}

export async function logout(everywhere = false): Promise<void> {
  try {
    await apiFetch(`/api/auth/logout${everywhere ? '?all=1' : ''}`, { method: 'POST' });
  } finally {
    setNativeToken(null);
  }
}

/** URL a la que redirigir para entrar con Google. */
export function googleLoginUrl(invite?: string): string {
  const params = invite ? `?invite=${encodeURIComponent(invite.trim().toUpperCase())}` : '';
  return `/api/auth/google/start${params}`;
}

export async function createInvite(params: { email?: string; role?: 'owner' | 'user' }): Promise<{
  code: string;
  email: string | null;
  role: string;
  expiresAt: number;
}> {
  return apiFetch('/api/auth/invite', { method: 'POST', body: JSON.stringify(params) });
}
