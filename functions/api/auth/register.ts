/**
 * POST /api/auth/register — alta de cuenta.
 *
 * El registro está cerrado: hace falta un código de invitación válido. La única
 * excepción es la primera cuenta de la instalación, que se crea con
 * AURUM_BOOTSTRAP_SECRET y recibe el rol owner; en cuanto existe un usuario esa
 * vía deja de funcionar.
 */

import type { PagesContext } from '../../_lib/types.ts';
import { clientIp, fail, normalizeEmail, readJson, validatePassword } from '../../_lib/http.ts';
import {
  audit,
  bootstrapAllowed,
  checkInvite,
  consumeInvite,
  createSession,
  createUser,
  findUserByEmail,
  hashPassword,
} from '../../_lib/auth.ts';
import { loginResponse } from '../../_lib/session-response.ts';

interface Body {
  email?: unknown;
  password?: unknown;
  name?: unknown;
  invite?: unknown;
  bootstrapSecret?: unknown;
}

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const { request, env } = context;
  const ip = clientIp(request);

  const body = await readJson<Body>(request, 8 * 1024);
  if (!body) return fail(400, 'bad_request', 'Cuerpo de la petición no válido.');

  const email = normalizeEmail(body.email);
  if (!email) return fail(400, 'bad_email', 'Introduce un correo válido.');

  const password = validatePassword(body.password);
  if (!password.ok) return fail(400, 'weak_password', password.message);

  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) || null : null;

  // Vía de alta: bootstrap del owner o invitación.
  const isBootstrap = await bootstrapAllowed(env, body.bootstrapSecret);
  let role: 'owner' | 'user' = 'owner';
  let inviteHash: string | null = null;

  if (!isBootstrap) {
    if (typeof body.invite !== 'string' || !body.invite.trim()) {
      return fail(403, 'invite_required', 'El registro es solo por invitación.');
    }
    const invite = await checkInvite(env, body.invite, email);
    if (!invite.ok) {
      await audit(env, { event: 'register_invite_rejected', route: '/api/auth/register', status: 403, ip, detail: { email } });
      return fail(403, 'invite_invalid', invite.message);
    }
    role = invite.role;
    inviteHash = invite.codeHash;
  }

  if (await findUserByEmail(env, email)) {
    return fail(409, 'email_taken', 'Ya existe una cuenta con ese correo.');
  }

  let user;
  try {
    user = await createUser(env, {
      email,
      passwordHash: await hashPassword(password.value),
      name,
      role,
      // Sin verificación por correo todavía: la invitación es lo que acredita
      // el alta. Marcarlo como verificado sería mentir en la base de datos.
      emailVerified: false,
    });
  } catch {
    // Choque con el índice único: alguien registró el mismo correo a la vez.
    return fail(409, 'email_taken', 'Ya existe una cuenta con ese correo.');
  }

  // La invitación se consume después de crear el usuario. Si otro registro
  // simultáneo se adelantó, se deshace el alta en lugar de regalar la cuenta.
  if (inviteHash && !(await consumeInvite(env, inviteHash, user.id))) {
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(user.id).run();
    return fail(409, 'invite_used', 'Esa invitación acaba de usarse.');
  }

  const { token, expiresAt } = await createSession(env, user.id, request);
  await audit(env, {
    userId: user.id,
    event: isBootstrap ? 'register_bootstrap_owner' : 'register',
    route: '/api/auth/register',
    status: 200,
    ip,
  });

  return loginResponse(request, user, token, expiresAt);
}
