/**
 * Middleware de /api/*: CORS con allowlist, sesión, protección CSRF,
 * límite de peticiones y auditoría.
 *
 * Antes de esto los proxies de IA eran públicos y respondían con
 * `Access-Control-Allow-Origin: *`: cualquiera con la URL podía gastar las
 * claves del proyecto. Ahora ninguna ruta de /api responde sin pasar por aquí.
 */

import type { PagesContext } from '../_lib/types.ts';
import { audit, resolveSession } from '../_lib/auth.ts';
import {
  bearerToken,
  clientIp,
  corsHeaders,
  fail,
  isAllowedOrigin,
  isNativeOrigin,
} from '../_lib/http.ts';
import { consume, limitHeaders, sweep } from '../_lib/ratelimit.ts';
import { randomId } from '../_lib/crypto.ts';

/** Rutas accesibles sin sesión. Todo lo demás exige usuario autenticado. */
const PUBLIC_PATHS = new Set([
  '/api/auth/config',
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/google/start',
  '/api/auth/google/callback',
  '/api/auth/exchange',
]);

/** Rutas de proveedores de IA, todas con el mismo tratamiento. */
const AI_ROUTES = new Set([
  '/api/anthropic', '/api/openai', '/api/deepseek',
  '/api/gemini', '/api/grok', '/api/openrouter',
]);

/** Límite que aplica a cada ruta, y si el cubo va por usuario o por IP. */
function limitsFor(path: string, method: string): string[] {
  if (path === '/api/auth/login') return ['auth:login'];
  if (path === '/api/auth/register') return ['auth:register'];
  if (path.startsWith('/api/auth/google') || path === '/api/auth/exchange') return ['auth:oauth'];
  if (path === '/api/auth/invite') return ['invite:create'];
  // Todos los proveedores comparten el cubo diario: el limite es de uso de IA,
  // no de un proveedor concreto.
  if (AI_ROUTES.has(path)) return [`ai:${path.slice('/api/'.length)}`, 'ai:daily'];
  if (path === '/api/keys') return [method === 'GET' ? 'state:read' : 'keys:write'];
  if (path === '/api/models') return ['state:read'];
  if (path === '/api/market') return ['market'];
  if (path.startsWith('/api/state')) return [method === 'GET' ? 'state:read' : 'state:write'];
  return [];
}

export async function onRequest(context: PagesContext): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, '') || url.pathname;
  const origin = request.headers.get('Origin');
  const cors = corsHeaders(env, request);
  const ip = clientIp(request);

  // Configuración incompleta: es preferible fallar cerrado y en voz alta.
  if (!env.DB) return fail(500, 'no_database', 'El binding D1 (DB) no está configurado.', cors);
  if (!env.AURUM_SIGNING_SECRET) {
    return fail(500, 'no_signing_secret', 'AURUM_SIGNING_SECRET no está configurada.', cors);
  }

  // Preflight: solo se responde a orígenes de la allowlist.
  if (request.method === 'OPTIONS') {
    if (!isAllowedOrigin(env, origin) && !isNativeOrigin(origin)) {
      return new Response(null, { status: 403 });
    }
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        'Access-Control-Allow-Origin': origin!,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, anthropic-beta, anthropic-version, X-AURUM-Version',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  const token = bearerToken(request);
  const session = await resolveSession(env, token);

  // CSRF: una petición con efectos secundarios autenticada por cookie solo se
  // acepta desde un origen conocido. Con Authorization: Bearer no aplica,
  // porque el navegador no adjunta esa cabecera de forma automática.
  const usesCookieAuth = !!session && !request.headers.get('Authorization');
  const mutating = request.method !== 'GET' && request.method !== 'HEAD';
  if (mutating && usesCookieAuth && !isAllowedOrigin(env, origin) && !isNativeOrigin(origin)) {
    await audit(env, { userId: session.user.id, event: 'csrf_blocked', route: path, status: 403, ip, detail: { origin } });
    return fail(403, 'bad_origin', 'Origen no autorizado para esta operación.', cors);
  }

  // Autenticación.
  const isPublic = PUBLIC_PATHS.has(path);
  if (!isPublic && !session) {
    return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.', cors);
  }

  // Límite de peticiones: por usuario si hay sesión, por IP si aún no la hay.
  const subject = session ? `u:${session.user.id}` : `ip:${ip}`;
  for (const name of limitsFor(path, request.method)) {
    const result = await consume(env, subject, name);
    if (!result.allowed) {
      await audit(env, { userId: session?.user.id ?? null, event: 'rate_limited', route: path, status: 429, ip, detail: { name } });
      return fail(429, 'rate_limited', 'Has superado el límite de peticiones. Inténtalo más tarde.', {
        ...cors,
        ...limitHeaders(result),
      });
    }
  }

  // Limpieza oportunista de cubos y sesiones caducadas.
  if (Math.random() < 0.01) context.waitUntil(sweep(env));

  context.data.requestId = randomId();
  if (session) {
    context.data.user = session.user;
    context.data.sessionId = session.sessionId;
  }

  let response: Response;
  try {
    response = await context.next();
  } catch (err) {
    await audit(env, {
      userId: session?.user.id ?? null,
      event: 'unhandled_error',
      route: path,
      status: 500,
      ip,
      detail: { message: String(err).slice(0, 500) },
    });
    return fail(500, 'internal_error', 'Error interno.', cors);
  }

  // Las cabeceras CORS se añaden aquí una sola vez, para que ninguna Function
  // pueda volver a emitir un comodín por descuido.
  const merged = new Headers(response.headers);
  for (const [k, v] of Object.entries(cors)) merged.set(k, v);
  merged.delete('Access-Control-Allow-Origin');
  if (isAllowedOrigin(env, origin) || isNativeOrigin(origin)) {
    merged.set('Access-Control-Allow-Origin', origin!);
    merged.set('Access-Control-Allow-Credentials', 'true');
  }

  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
}
