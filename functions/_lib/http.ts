/**
 * Utilidades HTTP compartidas: CORS con allowlist, cookies, respuestas JSON.
 *
 * Nota sobre CORS: la versión anterior de AURUM respondía
 * `Access-Control-Allow-Origin: *` en todas las Functions, lo que permitía a
 * cualquier página usar las claves de IA del proyecto. Aquí el origen se
 * compara siempre contra una allowlist explícita y nunca se emite comodín.
 */

import type { Env } from './types.ts';

export const SESSION_COOKIE = 'aurum_session';

/* ── Orígenes ────────────────────────────────────────────────── */

export function allowedOrigins(env: Env): string[] {
  return (env.AURUM_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(o => o.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function isAllowedOrigin(env: Env, origin: string | null): boolean {
  if (!origin) return false;
  return allowedOrigins(env).includes(origin.replace(/\/$/, ''));
}

export function corsHeaders(env: Env, request: Request): Record<string, string> {
  const origin = request.headers.get('Origin');
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (isAllowedOrigin(env, origin)) {
    headers['Access-Control-Allow-Origin'] = origin!;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

/**
 * La APK de Capacitor no envía un Origin http(s) normal, así que además del
 * allowlist se aceptan los esquemas propios de la app nativa.
 */
export function isNativeOrigin(origin: string | null): boolean {
  return origin === 'capacitor://localhost' || origin === 'http://localhost' || origin === 'ionic://localhost';
}

/* ── Respuestas ──────────────────────────────────────────────── */

export function json(body: unknown, init: ResponseInit = {}, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export function fail(status: number, code: string, message: string, extraHeaders: Record<string, string> = {}): Response {
  return json({ error: { code, message } }, { status }, extraHeaders);
}

/* ── Cookies ─────────────────────────────────────────────────── */

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/* ── Credencial entrante ─────────────────────────────────────── */

/**
 * El token de sesión llega por cookie en la web y por cabecera Authorization
 * en la APK, donde las cookies de terceros son poco fiables.
 */
export function bearerToken(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim() || null;
  return readCookie(request, SESSION_COOKIE);
}

/* ── Cliente ─────────────────────────────────────────────────── */

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For')?.split(',')[0].trim() ?? 'unknown';
}

export function userAgent(request: Request): string {
  return (request.headers.get('User-Agent') ?? '').slice(0, 255);
}

/* ── Entrada ─────────────────────────────────────────────────── */

/** Lee el cuerpo como JSON con límite de tamaño; devuelve null si no es válido. */
export async function readJson<T>(request: Request, maxBytes = 256 * 1024): Promise<T | null> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > maxBytes) return null;
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  // Validación deliberadamente simple: la verificación real es el envío/uso.
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/** Requisito mínimo de contraseña: longitud, que es lo que de verdad importa. */
export function validatePassword(raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof raw !== 'string') return { ok: false, message: 'La contraseña es obligatoria.' };
  if (raw.length < 12) return { ok: false, message: 'La contraseña debe tener al menos 12 caracteres.' };
  if (raw.length > 256) return { ok: false, message: 'La contraseña no puede superar los 256 caracteres.' };
  return { ok: true, value: raw };
}
