/**
 * Invitaciones. Solo el owner puede emitirlas y listarlas.
 *
 * POST /api/auth/invite  → crea un código (se muestra una única vez)
 * GET  /api/auth/invite  → lista las invitaciones emitidas, sin los códigos
 *
 * El código en claro no se guarda en ninguna parte: la tabla solo tiene su
 * SHA-256. Si se pierde, se emite otro.
 */

import type { PagesContext } from '../../_lib/types.ts';
import { clientIp, fail, json, normalizeEmail, readJson } from '../../_lib/http.ts';
import { audit, createInvite } from '../../_lib/auth.ts';
import { randomInviteCode } from '../../_lib/crypto.ts';

interface Body {
  email?: unknown;
  role?: unknown;
}

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const { request, env, data } = context;
  const user = data.user;
  if (!user) return fail(401, 'unauthenticated', 'No hay sesión activa.');
  if (user.role !== 'owner') return fail(403, 'forbidden', 'Solo el propietario puede invitar usuarios.');

  const body = (await readJson<Body>(request, 4 * 1024)) ?? {};

  // Un email en la invitación la ata a esa persona: aunque el código se filtre,
  // no sirve para registrar otra cuenta.
  let email: string | null = null;
  if (body.email !== undefined && body.email !== null && body.email !== '') {
    email = normalizeEmail(body.email);
    if (!email) return fail(400, 'bad_email', 'El correo de la invitación no es válido.');
  }

  const role: 'owner' | 'user' = body.role === 'owner' ? 'owner' : 'user';

  const code = randomInviteCode();
  const { expiresAt } = await createInvite(env, { code, email, role, createdBy: user.id });

  await audit(env, {
    userId: user.id,
    event: 'invite_created',
    route: '/api/auth/invite',
    status: 200,
    ip: clientIp(request),
    detail: { email, role },
  });

  return json({ code, email, role, expiresAt });
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { env, data } = context;
  const user = data.user;
  if (!user) return fail(401, 'unauthenticated', 'No hay sesión activa.');
  if (user.role !== 'owner') return fail(403, 'forbidden', 'Solo el propietario puede ver las invitaciones.');

  const { results } = await env.DB.prepare(
    `SELECT email, role, created_at, expires_at, used_at, used_by
       FROM invites
      ORDER BY created_at DESC
      LIMIT 100`,
  ).all<{ email: string | null; role: string; created_at: number; expires_at: number; used_at: number | null; used_by: string | null }>();

  return json({ invites: results });
}
