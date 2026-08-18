/**
 * POST /api/auth/logout — cierra la sesión actual.
 *
 * Con `?all=1` cierra además todas las demás sesiones del usuario, que es lo
 * que hay que hacer si se sospecha que un dispositivo se ha perdido.
 */

import type { PagesContext } from '../../_lib/types.ts';
import { clearSessionCookie, clientIp, fail, json } from '../../_lib/http.ts';
import { audit, revokeAllSessions, revokeSession } from '../../_lib/auth.ts';

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const { request, env, data } = context;
  const user = data.user;
  const sessionId = data.sessionId;
  if (!user || !sessionId) return fail(401, 'unauthenticated', 'No hay sesión activa.');

  const all = new URL(request.url).searchParams.get('all') === '1';
  if (all) {
    await revokeAllSessions(env, user.id);
  } else {
    await revokeSession(env, sessionId);
  }

  await audit(env, {
    userId: user.id,
    event: all ? 'logout_all' : 'logout',
    route: '/api/auth/logout',
    status: 200,
    ip: clientIp(request),
  });

  return json({ ok: true }, { status: 200 }, { 'Set-Cookie': clearSessionCookie() });
}
