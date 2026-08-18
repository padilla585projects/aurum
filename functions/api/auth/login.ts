/**
 * POST /api/auth/login — inicio de sesión con correo y contraseña.
 *
 * La respuesta es idéntica cuando el correo no existe y cuando la contraseña es
 * incorrecta, y en ambos casos se ejecuta una derivación PBKDF2 completa, para
 * no revelar por contenido ni por tiempo qué correos están registrados.
 */

import type { PagesContext } from '../../_lib/types.ts';
import { clientIp, fail, normalizeEmail, readJson } from '../../_lib/http.ts';
import { audit, createSession, findUserByEmail, hashPassword, setPasswordHash } from '../../_lib/auth.ts';
import { needsRehash, verifyPassword } from '../../_lib/crypto.ts';
import { loginResponse } from '../../_lib/session-response.ts';

interface Body {
  email?: unknown;
  password?: unknown;
}

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const { request, env } = context;
  const ip = clientIp(request);

  const body = await readJson<Body>(request, 8 * 1024);
  if (!body) return fail(400, 'bad_request', 'Cuerpo de la petición no válido.');

  const email = normalizeEmail(body.email);
  const password = typeof body.password === 'string' ? body.password : '';

  const invalid = () => fail(401, 'invalid_credentials', 'Correo o contraseña incorrectos.');

  if (!email || !password) {
    // Aun sin datos válidos se gasta el mismo trabajo que en un intento real.
    await verifyPassword(password || 'x', null);
    return invalid();
  }

  const user = await findUserByEmail(env, email);
  const ok = await verifyPassword(password, user?.password_hash ?? null);

  if (!user || !ok) {
    await audit(env, { userId: user?.id ?? null, event: 'login_failed', route: '/api/auth/login', status: 401, ip, detail: { email } });
    return invalid();
  }

  if (user.status !== 'active') {
    await audit(env, { userId: user.id, event: 'login_suspended', route: '/api/auth/login', status: 403, ip });
    return fail(403, 'account_suspended', 'Esta cuenta está suspendida.');
  }

  // Si el hash se generó con un coste inferior al actual, se regenera ahora que
  // tenemos la contraseña en claro. Es transparente para el usuario.
  if (needsRehash(user.password_hash)) {
    await setPasswordHash(env, user.id, await hashPassword(password));
  }

  const { token, expiresAt } = await createSession(env, user.id, request);
  await audit(env, { userId: user.id, event: 'login', route: '/api/auth/login', status: 200, ip });

  return loginResponse(
    request,
    { id: user.id, email: user.email, name: user.name, role: user.role, status: user.status },
    token,
    expiresAt,
  );
}
