/**
 * Cliente HTTP de la API de AURUM.
 *
 * En web la sesión viaja en una cookie httpOnly, que el navegador adjunta sola.
 * En la APK de Capacitor las cookies de terceros no son fiables, así que el
 * token se guarda en el almacenamiento del dispositivo y se envía en la
 * cabecera Authorization. `isNative` decide cuál de los dos caminos se usa.
 */

const NATIVE_TOKEN_KEY = 'aurum-session-token';

/** Capacitor sirve la app desde un esquema propio, no desde https://. */
export const isNative =
  typeof window !== 'undefined' &&
  (window.location.protocol === 'capacitor:' ||
    window.location.protocol === 'ionic:' ||
    // @ts-expect-error — Capacitor inyecta este objeto en tiempo de ejecución.
    !!window.Capacitor?.isNativePlatform?.());

/**
 * Base de la API. En la APK el origen es local, así que las llamadas tienen que
 * apuntar al despliegue real; en web es siempre el mismo origen.
 */
export const API_BASE: string = isNative
  ? (import.meta.env.VITE_API_BASE || 'https://aurum-7cm.pages.dev')
  : '';

export function getNativeToken(): string | null {
  try {
    return localStorage.getItem(NATIVE_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setNativeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(NATIVE_TOKEN_KEY, token);
    else localStorage.removeItem(NATIVE_TOKEN_KEY);
  } catch {
    /* almacenamiento no disponible */
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** true si el fallo es de red y no del servidor: permite seguir sin conexión. */
export function isOffline(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof ApiError && err.status === 0);
}

/**
 * Como `apiFetch`, pero devuelve la respuesta sin tocarla.
 *
 * Hace falta para lo que no es JSON —la descarga de la APK— donde intentar
 * parsearla la destruiría.
 */
export async function apiFetchRaw(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (isNative) {
    headers.set('X-AURUM-Client', 'native');
    const token = getNativeToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  return fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' });
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  if (isNative) {
    headers.set('X-AURUM-Client', 'native');
    const token = getNativeToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      credentials: 'include',
    });
  } catch {
    throw new ApiError(0, 'network', 'Sin conexión con el servidor.');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    /* respuesta no-JSON */
  }

  if (!res.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, error?.code ?? 'http_error', error?.message ?? `Error HTTP ${res.status}`);
  }

  return payload as T;
}
