/**
 * Límite de peticiones por ventana fija, con contadores en D1.
 *
 * Se eligió D1 en lugar de KV porque el proyecto ya necesita la base de datos y
 * así hay un solo binding que configurar. Con el volumen de una instalación
 * privada la escritura extra por petición es irrelevante; si algún día se abre
 * al público, este es el primer sitio a mover a KV o al Rate Limiting nativo.
 */

import type { Env } from './types.ts';

export interface Limit {
  /** Peticiones permitidas dentro de la ventana. */
  max: number;
  /** Duración de la ventana en segundos. */
  windowSeconds: number;
}

/**
 * Límites por ruta. Los de autenticación son deliberadamente estrictos: son la
 * superficie donde un atacante prueba contraseñas o códigos de invitación.
 */
export const LIMITS: Record<string, Limit> = {
  'auth:login':    { max: 10,  windowSeconds: 15 * 60 },
  'auth:register': { max: 5,   windowSeconds: 60 * 60 },
  'auth:oauth':    { max: 20,  windowSeconds: 15 * 60 },
  'ai:anthropic':  { max: 60,  windowSeconds: 60 * 60 },
  'ai:openai':     { max: 60,  windowSeconds: 60 * 60 },
  'ai:deepseek':   { max: 60,  windowSeconds: 60 * 60 },
  'ai:gemini':     { max: 60,  windowSeconds: 60 * 60 },
  'ai:grok':       { max: 60,  windowSeconds: 60 * 60 },
  // Mas holgado: es el destino de las consultas de datos publicos del Research,
  // que se lanzan en tandas.
  'ai:openrouter': { max: 120, windowSeconds: 60 * 60 },
  'keys:write':    { max: 30,  windowSeconds: 60 * 60 },
  'ai:daily':      { max: 400, windowSeconds: 24 * 60 * 60 },
  'market':        { max: 120, windowSeconds: 60 * 60 },
  'state:read':    { max: 600, windowSeconds: 60 * 60 },
  'state:write':   { max: 300, windowSeconds: 60 * 60 },
  'invite:create': { max: 20,  windowSeconds: 24 * 60 * 60 },
};

export interface LimitResult {
  allowed: boolean;
  remaining: number;
  /** Segundos hasta que la ventana se reinicia. */
  retryAfter: number;
  limit: number;
}

/**
 * Consume una unidad del cubo `<subject>:<name>` y dice si la petición pasa.
 *
 * `subject` es el id de usuario cuando hay sesión y la IP cuando no la hay
 * (registro y login, donde todavía no existe usuario).
 */
export async function consume(env: Env, subject: string, name: string): Promise<LimitResult> {
  const limit = LIMITS[name];
  if (!limit) return { allowed: true, remaining: Number.MAX_SAFE_INTEGER, retryAfter: 0, limit: 0 };

  const windowMs = limit.windowSeconds * 1000;
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const bucket = `${subject}:${name}:${windowStart}`;
  const expiresAt = windowStart + windowMs;

  let count: number;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO rate_limits (bucket, count, window_start, expires_at)
       VALUES (?, 1, ?, ?)
       ON CONFLICT(bucket) DO UPDATE SET count = count + 1
       RETURNING count`,
    ).bind(bucket, windowStart, expiresAt).first<{ count: number }>();
    count = row?.count ?? 1;
  } catch {
    // Si el contador falla, se deja pasar la petición: un fallo de D1 no debe
    // dejar la aplicación inutilizable. Queda registrado por el middleware.
    return { allowed: true, remaining: limit.max, retryAfter: 0, limit: limit.max };
  }

  return {
    allowed: count <= limit.max,
    remaining: Math.max(0, limit.max - count),
    retryAfter: Math.ceil((expiresAt - now) / 1000),
    limit: limit.max,
  };
}

/**
 * Borra cubos caducados. Se invoca de forma oportunista (≈1 de cada 100
 * peticiones) desde el middleware, vía waitUntil.
 */
export async function sweep(env: Env): Promise<void> {
  try {
    await env.DB.prepare(`DELETE FROM rate_limits WHERE expires_at < ?`).bind(Date.now()).run();
    await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(Date.now()).run();
  } catch {
    // Limpieza best-effort.
  }
}

export function limitHeaders(result: LimitResult): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(result.limit),
    'X-RateLimit-Remaining': String(result.remaining),
    ...(result.allowed ? {} : { 'Retry-After': String(result.retryAfter) }),
  };
}
