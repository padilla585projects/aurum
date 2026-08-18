/**
 * POST /api/auth/exchange — canjea el código del deep link por una sesión.
 *
 * Solo lo usa la APK. Tras el retorno de Google, la aplicación nativa recibe
 * `aurum://auth?code=…`; ese código no es una sesión, solo un vale de un uso y
 * dos minutos de vida. La sesión se crea aquí, en una petición que hace la
 * propia app, de modo que el token nunca pasa por la URL del deep link.
 */

import type { PagesContext } from '../../_lib/types.ts';
import { clientIp, fail, readJson } from '../../_lib/http.ts';
import { audit, createSession, findUserById } from '../../_lib/auth.ts';
import { hashToken } from '../../_lib/crypto.ts';
import { loginResponse } from '../../_lib/session-response.ts';

interface Body {
  code?: unknown;
}

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const { request, env } = context;
  const ip = clientIp(request);

  const body = await readJson<Body>(request, 4 * 1024);
  if (!body || typeof body.code !== 'string' || !body.code) {
    return fail(400, 'bad_request', 'Falta el código de acceso.');
  }

  const codeHash = await hashToken(body.code);
  const row = await env.DB.prepare(
    `SELECT user_id, expires_at, consumed_at FROM auth_exchange_codes WHERE code_hash = ?`,
  ).bind(codeHash).first<{ user_id: string; expires_at: number; consumed_at: number | null }>();

  const reject = () => fail(403, 'code_invalid', 'El código de acceso no es válido o ya se ha usado.');

  if (!row || row.consumed_at !== null || row.expires_at <= Date.now()) {
    await audit(env, { event: 'exchange_rejected', route: '/api/auth/exchange', status: 403, ip });
    return reject();
  }

  // El UPDATE condicionado evita que dos peticiones simultáneas canjeen el
  // mismo código y acaben con dos sesiones.
  const claimed = await env.DB.prepare(
    `UPDATE auth_exchange_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL`,
  ).bind(Date.now(), codeHash).run();
  if ((claimed.meta.changes ?? 0) === 0) return reject();

  const user = await findUserById(env, row.user_id);
  if (!user || user.status !== 'active') return reject();

  const { token, expiresAt } = await createSession(env, user.id, request);
  await audit(env, { userId: user.id, event: 'login_google_native', route: '/api/auth/exchange', status: 200, ip });

  return loginResponse(
    request,
    { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status },
    token,
    expiresAt,
  );
}
