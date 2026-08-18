/**
 * GET /api/auth/google/callback — retorno del flujo de Google.
 *
 * Reglas de vinculación de cuentas:
 *   · Si el `sub` de Google ya está asociado a un usuario, se inicia sesión.
 *   · Si no lo está pero existe una cuenta con ese correo, solo se vinculan si
 *     Google afirma que el correo está verificado. Sin eso, cualquiera que
 *     registrase un correo ajeno en su cuenta de Google podría apropiarse de
 *     una cuenta de AURUM.
 *   · Crear una cuenta nueva sigue exigiendo invitación.
 */

import type { PagesContext, SessionUser } from '../../../_lib/types.ts';
import { clientIp, readCookie, sessionCookie } from '../../../_lib/http.ts';
import {
  SESSION_TTL_SECONDS,
  audit,
  checkInvite,
  consumeInvite,
  createSession,
  createUser,
  findUserByEmail,
  findUserById,
} from '../../../_lib/auth.ts';
import { fromBase64Url, randomId, verifyPayload, timingSafeEqual } from '../../../_lib/crypto.ts';
import { OAUTH_COOKIE, redirectUri, type OAuthState } from './start.ts';

interface GoogleTokens {
  id_token?: string;
  error?: string;
}

interface GoogleClaims {
  sub?: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
}

function appUrl(env: { AURUM_PUBLIC_URL?: string }, request: Request): string {
  return (env.AURUM_PUBLIC_URL ?? new URL(request.url).origin).replace(/\/$/, '');
}

function backTo(base: string, params: Record<string, string>, cookie?: string): Response {
  const url = new URL(base + '/');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {
    Location: url.toString(),
    'Cache-Control': 'no-store',
  };
  // La cookie del flujo se borra siempre, salga bien o mal.
  const clear = `${OAUTH_COOKIE}=; Path=/api/auth/google; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  headers['Set-Cookie'] = cookie ?? clear;
  const res = new Response(null, { status: 302, headers });
  if (cookie) res.headers.append('Set-Cookie', clear);
  return res;
}

/** Lee las reclamaciones del id_token. Viene directo del endpoint de Google
 *  sobre TLS, así que no se vuelve a verificar la firma; solo se decodifica. */
function decodeIdToken(idToken: string): GoogleClaims | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]))) as GoogleClaims;
  } catch {
    return null;
  }
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { request, env } = context;
  const base = appUrl(env, request);
  const ip = clientIp(request);
  const url = new URL(request.url);

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return backTo(base, { auth: 'error', reason: 'google_disabled' });
  }

  if (url.searchParams.get('error')) {
    return backTo(base, { auth: 'error', reason: 'cancelled' });
  }

  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const rawCookie = readCookie(request, OAUTH_COOKIE);
  if (!code || !stateParam || !rawCookie) {
    return backTo(base, { auth: 'error', reason: 'bad_state' });
  }

  const state = await verifyPayload<OAuthState>(env.AURUM_SIGNING_SECRET, rawCookie);
  if (!state || !timingSafeEqual(state.nonce, stateParam)) {
    await audit(env, { event: 'oauth_state_mismatch', route: '/api/auth/google/callback', status: 400, ip });
    return backTo(base, { auth: 'error', reason: 'bad_state' });
  }

  // Intercambio del código por el id_token.
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: state.verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(env, request),
    }),
  });

  const tokens = (await tokenRes.json().catch(() => null)) as GoogleTokens | null;
  if (!tokenRes.ok || !tokens?.id_token) {
    await audit(env, { event: 'oauth_token_exchange_failed', route: '/api/auth/google/callback', status: 502, ip });
    return backTo(base, { auth: 'error', reason: 'exchange_failed' });
  }

  const claims = decodeIdToken(tokens.id_token);
  const sub = claims?.sub;
  const email = claims?.email?.trim().toLowerCase();
  const emailVerified = claims?.email_verified === true || claims?.email_verified === 'true';
  if (!sub || !email) {
    return backTo(base, { auth: 'error', reason: 'no_claims' });
  }

  const now = Date.now();
  let user: SessionUser | null = null;

  // 1) Cuenta de Google ya vinculada.
  const link = await env.DB.prepare(
    `SELECT user_id FROM oauth_accounts WHERE provider = 'google' AND provider_user_id = ?`,
  ).bind(sub).first<{ user_id: string }>();

  if (link) {
    const row = await findUserById(env, link.user_id);
    if (!row) return backTo(base, { auth: 'error', reason: 'unknown_user' });
    if (row.status !== 'active') return backTo(base, { auth: 'error', reason: 'suspended' });
    user = { id: row.id, email: row.email, name: row.name, role: row.role, status: row.status };
  }

  // 2) Cuenta existente con el mismo correo: vincular si Google lo verificó.
  if (!user) {
    const existing = await findUserByEmail(env, email);
    if (existing) {
      if (!emailVerified) {
        await audit(env, { userId: existing.id, event: 'oauth_link_rejected', route: '/api/auth/google/callback', status: 403, ip });
        return backTo(base, { auth: 'error', reason: 'email_unverified' });
      }
      if (existing.status !== 'active') return backTo(base, { auth: 'error', reason: 'suspended' });
      await env.DB.prepare(
        `INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email, created_at)
         VALUES ('google', ?, ?, ?, ?)`,
      ).bind(sub, existing.id, email, now).run();
      await env.DB.prepare(`UPDATE users SET email_verified = 1 WHERE id = ?`).bind(existing.id).run();
      await audit(env, { userId: existing.id, event: 'oauth_linked', route: '/api/auth/google/callback', status: 200, ip });
      user = { id: existing.id, email: existing.email, name: existing.name, role: existing.role, status: existing.status };
    }
  }

  // 3) Cuenta nueva: solo con invitación válida.
  if (!user) {
    if (!state.invite) {
      return backTo(base, { auth: 'error', reason: 'invite_required' });
    }
    const invite = await checkInvite(env, state.invite, email);
    if (!invite.ok) {
      await audit(env, { event: 'oauth_invite_rejected', route: '/api/auth/google/callback', status: 403, ip, detail: { email } });
      return backTo(base, { auth: 'error', reason: 'invite_invalid' });
    }

    const created = await createUser(env, {
      email,
      passwordHash: null,           // cuenta solo-Google; puede añadir contraseña después
      name: claims?.name?.slice(0, 80) ?? null,
      role: invite.role,
      emailVerified,
    });

    if (!(await consumeInvite(env, invite.codeHash, created.id))) {
      await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(created.id).run();
      return backTo(base, { auth: 'error', reason: 'invite_used' });
    }

    await env.DB.prepare(
      `INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email, created_at)
       VALUES ('google', ?, ?, ?, ?)`,
    ).bind(sub, created.id, email, now).run();

    await audit(env, { userId: created.id, event: 'register_google', route: '/api/auth/google/callback', status: 200, ip });
    user = created;
  }

  const { token } = await createSession(env, user.id, request);
  await audit(env, { userId: user.id, event: 'login_google', route: '/api/auth/google/callback', status: 200, ip });

  return backTo(base, { auth: 'ok', rid: randomId().slice(0, 8) }, sessionCookie(token, SESSION_TTL_SECONDS));
}
