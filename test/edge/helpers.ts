/**
 * Utilidades comunes de las pruebas del edge.
 *
 * `dispatch` reproduce lo que hace Cloudflare Pages con una petición a /api:
 * ejecuta primero `functions/api/_middleware.ts` y, si este llama a `next()`,
 * el handler del fichero que corresponde a la ruta. Sin esto habría que probar
 * los handlers sueltos, y entonces las pruebas no dirían nada sobre las cuatro
 * cosas que de verdad protegen la aplicación —sesión, CORS, CSRF y límites—,
 * que viven todas en el middleware.
 */

import { env } from 'cloudflare:test';
import type { AurumData, Env, PagesContext } from '../../functions/_lib/types.ts';
import { hashPassword, hashToken, randomToken } from '../../functions/_lib/crypto.ts';

import { onRequest as middleware } from '../../functions/api/_middleware.ts';
import * as routeConfig from '../../functions/api/auth/config.ts';
import * as routeLogin from '../../functions/api/auth/login.ts';
import * as routeLogout from '../../functions/api/auth/logout.ts';
import * as routeMe from '../../functions/api/auth/me.ts';
import * as routeRegister from '../../functions/api/auth/register.ts';
import * as routeInvite from '../../functions/api/auth/invite.ts';
import * as routeExchange from '../../functions/api/auth/exchange.ts';
import * as routeGoogleStart from '../../functions/api/auth/google/start.ts';
import * as routeGoogleCallback from '../../functions/api/auth/google/callback.ts';
import * as routeState from '../../functions/api/state.ts';
import * as routeMarket from '../../functions/api/market.ts';
import * as routeAnthropic from '../../functions/api/anthropic.ts';
import * as routeOpenai from '../../functions/api/openai.ts';
import * as routeDeepseek from '../../functions/api/deepseek.ts';
import * as routeGemini from '../../functions/api/gemini.ts';
import * as routeGrok from '../../functions/api/grok.ts';
import * as routeOpenrouter from '../../functions/api/openrouter.ts';
import * as routeKeys from '../../functions/api/keys.ts';
import * as routeModels from '../../functions/api/models.ts';
import * as routeBackendConfig from '../../functions/api/backend-config.ts';
import * as routeApk from '../../functions/api/apk.ts';
import * as routeApkActualizacion from '../../functions/api/apk-actualizacion.ts';

type Handler = (context: PagesContext) => Promise<Response>;
type HandlerModule = Record<string, unknown>;

const ROUTES: Record<string, HandlerModule> = {
  '/api/auth/config': routeConfig,
  '/api/auth/login': routeLogin,
  '/api/auth/logout': routeLogout,
  '/api/auth/me': routeMe,
  '/api/auth/register': routeRegister,
  '/api/auth/invite': routeInvite,
  '/api/auth/exchange': routeExchange,
  '/api/auth/google/start': routeGoogleStart,
  '/api/auth/google/callback': routeGoogleCallback,
  '/api/state': routeState,
  '/api/market': routeMarket,
  '/api/anthropic': routeAnthropic,
  '/api/openai': routeOpenai,
  '/api/deepseek': routeDeepseek,
  '/api/gemini': routeGemini,
  '/api/grok': routeGrok,
  '/api/openrouter': routeOpenrouter,
  '/api/keys': routeKeys,
  '/api/models': routeModels,
  '/api/backend-config': routeBackendConfig,
  '/api/apk': routeApk,
  '/api/apk-actualizacion': routeApkActualizacion,
};

const METHOD_EXPORT: Record<string, string> = {
  GET: 'onRequestGet',
  POST: 'onRequestPost',
  PUT: 'onRequestPut',
  DELETE: 'onRequestDelete',
  PATCH: 'onRequestPatch',
};

/** Origen propio: está en la allowlist y es el que usa el navegador legítimo. */
const BASE = 'https://aurum.test';

export interface DispatchInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Origin de la petición. `null` la manda sin cabecera Origin. */
  origin?: string | null;
  /** Sesión por cookie (navegador). */
  cookie?: string;
  /** Sesión por cabecera Authorization (APK). */
  bearer?: string;
  /** Sobrescribe variables del entorno solo para esta petición. */
  envOverrides?: Partial<Env>;
}

export async function dispatch(path: string, init: DispatchInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const [pathname] = path.split('?');
  const module = ROUTES[pathname.replace(/\/$/, '')];

  const headers = new Headers(init.headers ?? {});
  if (init.origin !== null) headers.set('Origin', init.origin ?? BASE);
  if (init.cookie) headers.set('Cookie', `aurum_session=${init.cookie}`);
  if (init.bearer) headers.set('Authorization', `Bearer ${init.bearer}`);
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  // Sin IP no se puede probar el límite por dirección, que es el que protege
  // login y registro antes de que exista usuario.
  if (!headers.has('CF-Connecting-IP')) headers.set('CF-Connecting-IP', '198.51.100.7');

  const body =
    init.body === undefined || method === 'GET' || method === 'HEAD'
      ? undefined
      : typeof init.body === 'string'
        ? init.body
        : JSON.stringify(init.body);

  const request = new Request(new URL(path, BASE).toString(), { method, headers, body });

  const pending: Promise<unknown>[] = [];
  const data = {} as AurumData;
  const context: PagesContext = {
    request,
    env: { ...env, ...(init.envOverrides ?? {}) } as Env,
    params: {},
    data,
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
    next: async () => {
      if (!module) return new Response('Not found', { status: 404 });
      const handler = (module[METHOD_EXPORT[method] ?? ''] ?? module.onRequest) as Handler | undefined;
      if (!handler) return new Response('Method not allowed', { status: 405 });
      return handler(context);
    },
  };

  const response = await middleware(context);
  // Se esperan aquí las tareas en segundo plano (auditoría, consumo de IA) para
  // que las aserciones sobre la base de datos no dependan del azar.
  await Promise.allSettled(pending);
  return response;
}

/* ── Semillas ────────────────────────────────────────────────── */

export interface SeededUser {
  id: string;
  email: string;
  role: 'owner' | 'user';
  status: 'active' | 'suspended';
}

/**
 * Inserta un usuario directamente en D1. Se salta el registro a propósito: cada
 * alta real cuesta una derivación PBKDF2 de 100.000 iteraciones, y la mayoría
 * de las pruebas solo necesitan que el usuario exista.
 */
export async function seedUser(
  overrides: Partial<SeededUser> & { passwordHash?: string | null } = {},
): Promise<SeededUser> {
  const user: SeededUser = {
    id: overrides.id ?? crypto.randomUUID(),
    email: overrides.email ?? `${crypto.randomUUID().slice(0, 8)}@aurum.test`,
    role: overrides.role ?? 'user',
    status: overrides.status ?? 'active',
  };
  await env.DB.prepare(
    `INSERT INTO users (id, email, email_verified, password_hash, name, role, status, created_at)
     VALUES (?, ?, 0, ?, NULL, ?, ?, ?)`,
  ).bind(user.id, user.email, overrides.passwordHash ?? null, user.role, user.status, Date.now()).run();
  return user;
}

/** Crea una sesión válida y devuelve el token en claro. */
export async function seedSession(userId: string, opts: { expiresAt?: number } = {}): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, 'vitest', '198.51.100.7')`,
  ).bind(await hashToken(token), userId, now, opts.expiresAt ?? now + 3_600_000, now).run();
  return token;
}

/** Usuario activo con sesión abierta, que es el punto de partida más frecuente. */
export async function seedLoggedIn(
  overrides: Partial<SeededUser> = {},
): Promise<{ user: SeededUser; token: string }> {
  const user = await seedUser(overrides);
  return { user, token: await seedSession(user.id) };
}

/**
 * Hash PBKDF2 memoizado. Deriva una sola vez por contraseña en toda la suite en
 * lugar de una vez por prueba.
 */
const hashCache = new Map<string, Promise<string>>();
export function passwordHash(password: string): Promise<string> {
  let cached = hashCache.get(password);
  if (!cached) {
    cached = hashPassword(password);
    hashCache.set(password, cached);
  }
  return cached;
}

/** Cuenta filas de una tabla, para comprobar efectos secundarios. */
export async function countRows(table: string, where = '1=1', ...binds: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
