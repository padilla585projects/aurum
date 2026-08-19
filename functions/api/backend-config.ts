/**
 * /api/backend-config — dirección y token del backend privado del usuario.
 *
 *   GET    → la configuración guardada, o null si no hay
 *   PUT    → la guarda o reemplaza
 *   DELETE → la borra
 *
 * A diferencia de las claves de IA, **este token sí se devuelve al cliente**:
 * es el navegador quien llama al backend por la tailnet, no el servidor. El
 * cifrado en reposo protege la base de datos frente a quien la lea, no frente a
 * quien tenga la sesión del usuario. Es la contrapartida de que la
 * configuración siga al usuario entre dispositivos en vez de repetirse en cada
 * uno.
 */

import type { PagesContext } from '../_lib/types.ts';
import { clientIp, fail, json, readJson } from '../_lib/http.ts';
import { audit } from '../_lib/auth.ts';
import { decryptSecret, encryptSecret } from '../_lib/secrets.ts';

const MAX_URL = 300;
const MAX_TOKEN = 400;

interface Body {
  url?: unknown;
  token?: unknown;
}

/** Etiqueta que ata el criptograma a su dueño. */
const ambito = (userId: string) => `${userId}:backend`;

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { env, data } = context;
  const user = data.user;
  if (!user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  const fila = await env.DB.prepare(
    `SELECT url, token_enc, updated_at FROM user_backend_config WHERE user_id = ?`,
  ).bind(user.id).first<{ url: string; token_enc: string; updated_at: number }>();

  if (!fila) return json({ config: null });

  const token = await decryptSecret(env.AURUM_SIGNING_SECRET, fila.token_enc, ambito(user.id));
  if (token === null) {
    // Criptograma ilegible: mejor decir que no hay configuración que devolver
    // algo a medias con lo que el cliente fallaría más adelante sin saber por qué.
    return json({ config: null });
  }

  return json({ config: { url: fila.url, apiKey: token, updatedAt: fila.updated_at } });
}

export async function onRequestPut(context: PagesContext): Promise<Response> {
  const { request, env, data } = context;
  const user = data.user;
  if (!user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  const body = await readJson<Body>(request, 4 * 1024);
  if (!body) return fail(400, 'bad_request', 'Cuerpo de la petición no válido.');

  const url = typeof body.url === 'string' ? body.url.trim().replace(/\/$/, '') : '';
  const token = typeof body.token === 'string' ? body.token.trim() : '';

  if (!url || url.length > MAX_URL) return fail(400, 'bad_url', 'La dirección no es válida.');
  if (!/^https?:\/\//.test(url)) return fail(400, 'bad_url', 'La dirección tiene que empezar por http:// o https://');
  if (!token || token.length > MAX_TOKEN) return fail(400, 'bad_token', 'El token no es válido.');

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO user_backend_config (user_id, url, token_enc, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       url = excluded.url,
       token_enc = excluded.token_enc,
       updated_at = excluded.updated_at`,
  ).bind(user.id, url, await encryptSecret(env.AURUM_SIGNING_SECRET, token, ambito(user.id)), now).run();

  // Se registra la dirección, nunca el token.
  await audit(env, {
    userId: user.id,
    event: 'backend_config_set',
    route: '/api/backend-config',
    status: 200,
    ip: clientIp(request),
    detail: { url },
  });

  return json({ ok: true, url, updatedAt: now });
}

export async function onRequestDelete(context: PagesContext): Promise<Response> {
  const { request, env, data } = context;
  const user = data.user;
  if (!user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  await env.DB.prepare(`DELETE FROM user_backend_config WHERE user_id = ?`).bind(user.id).run();
  await audit(env, {
    userId: user.id,
    event: 'backend_config_deleted',
    route: '/api/backend-config',
    status: 200,
    ip: clientIp(request),
  });

  return json({ ok: true });
}
