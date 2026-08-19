/**
 * /api/keys — claves de proveedor que aporta el usuario desde Ajustes.
 *
 *   GET    /api/keys              → qué proveedores tiene configurados
 *   PUT    /api/keys              → guarda o reemplaza una clave
 *   DELETE /api/keys?provider=x   → la borra
 *
 * Regla que gobierna todo este fichero: **una clave guardada no vuelve nunca al
 * cliente**. El GET devuelve solo una pista con los últimos cuatro caracteres,
 * suficiente para reconocerla y inútil para usarla. Tampoco aparece en la
 * auditoría ni en los registros.
 */

import type { PagesContext } from '../_lib/types.ts';
import { clientIp, fail, json, readJson } from '../_lib/http.ts';
import { audit } from '../_lib/auth.ts';
import { PROVIDERS, PROVIDER_IDS, isProvider } from '../_lib/ai-proxy.ts';
import { encryptSecret, keyHint } from '../_lib/secrets.ts';

const MAX_KEY_LENGTH = 400;
const MAX_MODEL_LENGTH = 120;

interface Body {
  provider?: unknown;
  key?: unknown;
  model?: unknown;
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { env, data } = context;
  const user = data.user;
  if (!user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  const { results } = await env.DB.prepare(
    `SELECT provider, hint, model, updated_at FROM user_provider_keys WHERE user_id = ?`,
  ).bind(user.id).all<{ provider: string; hint: string; model: string | null; updated_at: number }>();

  const propias = new Map(results.map(r => [r.provider, r]));

  // Se enumeran todos los proveedores para que Ajustes sepa qué puede ofrecer,
  // marcando de dónde saldría la clave en cada caso.
  const providers = PROVIDER_IDS.map(id => {
    const propia = propias.get(id);
    return {
      id,
      label: PROVIDERS[id].label,
      hasProjectKey: !!PROVIDERS[id].projectKey(env),
      hasOwnKey: !!propia,
      hint: propia?.hint ?? null,
      model: propia?.model ?? null,
      updatedAt: propia?.updated_at ?? null,
      /** true si la lista de modelos está restringida (clave del proyecto). */
      restricted: !!PROVIDERS[id].allowed && !propia,
    };
  });

  return json({ providers });
}

export async function onRequestPut(context: PagesContext): Promise<Response> {
  const { request, env, data } = context;
  const user = data.user;
  if (!user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  const body = await readJson<Body>(request, 8 * 1024);
  if (!body) return fail(400, 'bad_request', 'Cuerpo de la petición no válido.');

  if (!isProvider(body.provider)) {
    return fail(400, 'bad_provider', 'Proveedor desconocido.');
  }
  const provider = body.provider;

  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) return fail(400, 'bad_key', 'La clave no puede estar vacía.');
  if (key.length > MAX_KEY_LENGTH) return fail(400, 'bad_key', 'La clave es demasiado larga.');

  let model: string | null = null;
  if (typeof body.model === 'string' && body.model.trim()) {
    model = body.model.trim().slice(0, MAX_MODEL_LENGTH);
  }

  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO user_provider_keys (user_id, provider, key_enc, hint, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET
       key_enc = excluded.key_enc,
       hint = excluded.hint,
       model = excluded.model,
       updated_at = excluded.updated_at`,
  ).bind(
    user.id,
    provider,
    await encryptSecret(env.AURUM_SIGNING_SECRET, key, `${user.id}:${provider}`),
    keyHint(key),
    model,
    now,
    now,
  ).run();

  // Se registra el hecho, nunca el valor ni la pista.
  await audit(env, {
    userId: user.id,
    event: 'provider_key_set',
    route: '/api/keys',
    status: 200,
    ip: clientIp(request),
    detail: { provider, model },
  });

  return json({ provider, hint: keyHint(key), model });
}

export async function onRequestDelete(context: PagesContext): Promise<Response> {
  const { request, env, data } = context;
  const user = data.user;
  if (!user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  const provider = new URL(request.url).searchParams.get('provider');
  if (!isProvider(provider)) return fail(400, 'bad_provider', 'Proveedor desconocido.');

  await env.DB.prepare(
    `DELETE FROM user_provider_keys WHERE user_id = ? AND provider = ?`,
  ).bind(user.id, provider).run();

  await audit(env, {
    userId: user.id,
    event: 'provider_key_deleted',
    route: '/api/keys',
    status: 200,
    ip: clientIp(request),
    detail: { provider },
  });

  return json({ ok: true });
}
