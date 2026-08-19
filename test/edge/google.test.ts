/**
 * Acceso con Google.
 *
 * Lo que se prueba aquí no es que el flujo funcione, sino las reglas de
 * vinculación de cuentas: que un `sub` de Google no se pueda apropiar de una
 * cuenta ajena aprovechando un correo sin verificar, que crear cuenta nueva
 * siga exigiendo invitación, y que en la APK el token de sesión no viaje jamás
 * dentro del deep link.
 */

import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashToken, pkceChallenge, toBase64Url } from '../../functions/_lib/crypto.ts';
import { countRows, dispatch, seedUser } from './helpers.ts';

const GOOGLE = { GOOGLE_CLIENT_ID: 'id-de-prueba.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'secreto-de-google' };

afterEach(() => {
  vi.unstubAllGlobals();
});

/** id_token de Google: cabecera y firma no se comprueban, solo se decodifica el cuerpo. */
function idToken(claims: Record<string, unknown>): string {
  const parte = (v: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(v)));
  return `${parte({ alg: 'RS256' })}.${parte(claims)}.firma-no-verificada`;
}

/** Sustituye el intercambio de código con Google por una respuesta fija. */
function interceptarGoogle(respuesta: Response | (() => Response)) {
  const espia = vi.fn(async () => (typeof respuesta === 'function' ? respuesta() : respuesta.clone()));
  vi.stubGlobal('fetch', espia);
  return espia;
}

function tokenOk(claims: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ id_token: idToken(claims) }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Arranca el flujo y devuelve lo que el navegador tendría al volver de Google. */
async function iniciar(query = ''): Promise<{ nonce: string; cookie: string; authorize: URL }> {
  const res = await dispatch(`/api/auth/google/start${query}`, { envOverrides: GOOGLE });
  expect(res.status).toBe(302);
  const authorize = new URL(res.headers.get('Location')!);
  const setCookie = res.headers.get('Set-Cookie')!;
  return {
    nonce: authorize.searchParams.get('state')!,
    cookie: decodeURIComponent(setCookie.slice(setCookie.indexOf('=') + 1, setCookie.indexOf(';'))),
    authorize,
  };
}

/** Completa el retorno de Google con el estado que dejó `iniciar`. */
async function volver(
  flujo: { nonce: string; cookie: string },
  claims: Record<string, unknown>,
  overrides: Record<string, string> = {},
): Promise<Response> {
  interceptarGoogle(() => tokenOk(claims));
  return dispatch(`/api/auth/google/callback?code=codigo-de-google&state=${flujo.nonce}`, {
    headers: { Cookie: `aurum_oauth=${encodeURIComponent(flujo.cookie)}` },
    envOverrides: { ...GOOGLE, ...overrides },
  });
}

function destino(res: Response): URL {
  return new URL(res.headers.get('Location')!);
}

describe('inicio del flujo', () => {
  it('devuelve 503 si Google no está configurado en el despliegue', async () => {
    const res = await dispatch('/api/auth/google/start');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'google_disabled' } });
  });

  it('redirige a Google con PKCE y guarda el estado en una cookie httpOnly', async () => {
    const res = await dispatch('/api/auth/google/start', { envOverrides: GOOGLE });
    expect(res.status).toBe(302);

    const url = new URL(res.headers.get('Location')!);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(GOOGLE.GOOGLE_CLIENT_ID);
    expect(url.searchParams.get('redirect_uri')).toBe('https://aurum.test/api/auth/google/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();

    const cookie = res.headers.get('Set-Cookie')!;
    expect(cookie).toContain('aurum_oauth=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    // Lax, no Strict: si no, la cookie no sobrevive al retorno desde Google.
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api/auth/google');
  });

  it('el verificador de la cookie es el del challenge que ve Google', async () => {
    const flujo = await iniciar();
    const espia = interceptarGoogle(() => tokenOk({ sub: 'g-1', email: 'x@aurum.test' }));

    await dispatch(`/api/auth/google/callback?code=c&state=${flujo.nonce}`, {
      headers: { Cookie: `aurum_oauth=${encodeURIComponent(flujo.cookie)}` },
      envOverrides: GOOGLE,
    });

    const cuerpo = new URLSearchParams((espia.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(await pkceChallenge(cuerpo.get('code_verifier')!)).toBe(flujo.authorize.searchParams.get('code_challenge'));
    expect(cuerpo.get('client_secret')).toBe(GOOGLE.GOOGLE_CLIENT_SECRET);
    expect(cuerpo.get('grant_type')).toBe('authorization_code');
  });
});

describe('retorno: estado y errores', () => {
  it('vuelve a la aplicación con el motivo si Google no está configurado', async () => {
    const res = await dispatch('/api/auth/google/callback?code=c&state=s');
    expect(destino(res).searchParams.get('reason')).toBe('google_disabled');
  });

  it('trata la cancelación del usuario como tal', async () => {
    const res = await dispatch('/api/auth/google/callback?error=access_denied', { envOverrides: GOOGLE });
    expect(destino(res).searchParams.get('reason')).toBe('cancelled');
  });

  it('sin la cookie del flujo no se completa nada', async () => {
    const res = await dispatch('/api/auth/google/callback?code=c&state=s', { envOverrides: GOOGLE });
    expect(destino(res).searchParams.get('reason')).toBe('bad_state');
  });

  it('un state que no coincide con la cookie se rechaza y queda auditado', async () => {
    const flujo = await iniciar();
    const res = await dispatch('/api/auth/google/callback?code=c&state=nonce-ajeno', {
      headers: { Cookie: `aurum_oauth=${encodeURIComponent(flujo.cookie)}` },
      envOverrides: GOOGLE,
    });

    expect(destino(res).searchParams.get('reason')).toBe('bad_state');
    expect(await countRows('audit_log', 'event = ?', 'oauth_state_mismatch')).toBe(1);
  });

  it('si el intercambio con Google falla, no se crea nada', async () => {
    const flujo = await iniciar();
    interceptarGoogle(() => new Response('{"error":"invalid_grant"}', { status: 400 }));

    const res = await dispatch(`/api/auth/google/callback?code=c&state=${flujo.nonce}`, {
      headers: { Cookie: `aurum_oauth=${encodeURIComponent(flujo.cookie)}` },
      envOverrides: GOOGLE,
    });

    expect(destino(res).searchParams.get('reason')).toBe('exchange_failed');
    expect(await countRows('audit_log', 'event = ?', 'oauth_token_exchange_failed')).toBe(1);
    expect(await countRows('users')).toBe(0);
  });

  it('un id_token sin sub o sin correo no identifica a nadie', async () => {
    const flujo = await iniciar();
    const res = await volver(flujo, { name: 'Sin identidad' });
    expect(destino(res).searchParams.get('reason')).toBe('no_claims');
  });

  it('la cookie del flujo se borra salga bien o mal', async () => {
    const flujo = await iniciar();
    const res = await volver(flujo, { name: 'Sin identidad' });
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });
});

describe('vinculación de cuentas', () => {
  it('vincula con una cuenta existente solo si Google verificó el correo', async () => {
    const user = await seedUser({ email: 'adrian@aurum.test' });
    const flujo = await iniciar();

    const res = await volver(flujo, { sub: 'google-123', email: 'adrian@aurum.test', email_verified: true });

    expect(destino(res).searchParams.get('auth')).toBe('ok');
    expect(res.headers.get('Set-Cookie')).toContain('aurum_session=');
    expect(await countRows('oauth_accounts', 'user_id = ? AND provider_user_id = ?', user.id, 'google-123')).toBe(1);
    expect(await countRows('users', 'id = ? AND email_verified = 1', user.id)).toBe(1);
    expect(await countRows('sessions', 'user_id = ?', user.id)).toBe(1);
  });

  it('no vincula si Google no confirma el correo: sería apropiarse de la cuenta', async () => {
    const user = await seedUser({ email: 'adrian@aurum.test' });
    const flujo = await iniciar();

    const res = await volver(flujo, { sub: 'google-impostor', email: 'adrian@aurum.test', email_verified: false });

    expect(destino(res).searchParams.get('reason')).toBe('email_unverified');
    expect(await countRows('oauth_accounts')).toBe(0);
    expect(await countRows('sessions', 'user_id = ?', user.id)).toBe(0);
    expect(await countRows('audit_log', 'event = ?', 'oauth_link_rejected')).toBe(1);
  });

  it('una cuenta ya vinculada entra directamente, sin invitación', async () => {
    const user = await seedUser();
    await env.DB.prepare(
      `INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email, created_at)
       VALUES ('google', 'google-ya-vinculado', ?, ?, ?)`,
    ).bind(user.id, user.email, Date.now()).run();

    const flujo = await iniciar();
    const res = await volver(flujo, { sub: 'google-ya-vinculado', email: user.email, email_verified: true });

    expect(destino(res).searchParams.get('auth')).toBe('ok');
    expect(await countRows('sessions', 'user_id = ?', user.id)).toBe(1);
  });

  it('una cuenta suspendida no entra por esta vía', async () => {
    const user = await seedUser({ status: 'suspended' });
    await env.DB.prepare(
      `INSERT INTO oauth_accounts (provider, provider_user_id, user_id, email, created_at)
       VALUES ('google', 'google-suspendido', ?, ?, ?)`,
    ).bind(user.id, user.email, Date.now()).run();

    const flujo = await iniciar();
    const res = await volver(flujo, { sub: 'google-suspendido', email: user.email, email_verified: true });

    expect(destino(res).searchParams.get('reason')).toBe('suspended');
    expect(await countRows('sessions')).toBe(0);
  });
});

describe('alta con Google', () => {
  /** Invitación válida sembrada directamente, con su hash. */
  async function sembrarInvitacion(code: string, opts: { email?: string | null; role?: string } = {}) {
    await env.DB.prepare(
      `INSERT INTO invites (code_hash, email, role, created_by, created_at, expires_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).bind(await hashToken(code), opts.email ?? null, opts.role ?? 'user', Date.now(), Date.now() + 600_000).run();
  }

  it('sin invitación no se crea cuenta', async () => {
    const flujo = await iniciar();
    const res = await volver(flujo, { sub: 'google-nuevo', email: 'nuevo@aurum.test', email_verified: true });

    expect(destino(res).searchParams.get('reason')).toBe('invite_required');
    expect(await countRows('users')).toBe(0);
  });

  it('con invitación crea la cuenta, la vincula y consume el código', async () => {
    await sembrarInvitacion('INVITA-GOOGLE');
    const flujo = await iniciar('?invite=invita-google');

    const res = await volver(flujo, { sub: 'google-nuevo', email: 'nuevo@aurum.test', email_verified: true, name: 'Nuevo' });

    expect(destino(res).searchParams.get('auth')).toBe('ok');
    expect(await countRows('users', 'email = ?', 'nuevo@aurum.test')).toBe(1);
    expect(await countRows('oauth_accounts', 'provider_user_id = ?', 'google-nuevo')).toBe(1);
    expect(await countRows('invites', 'used_at IS NOT NULL')).toBe(1);

    // Cuenta solo-Google: sin contraseña y con el correo ya verificado.
    const fila = await env.DB.prepare('SELECT password_hash, email_verified, name FROM users WHERE email = ?')
      .bind('nuevo@aurum.test')
      .first<{ password_hash: string | null; email_verified: number; name: string }>();
    expect(fila).toMatchObject({ password_hash: null, email_verified: 1, name: 'Nuevo' });
  });

  it('una invitación emitida a otro correo no sirve', async () => {
    await sembrarInvitacion('INVITA-GOOGLE', { email: 'esperado@aurum.test' });
    const flujo = await iniciar('?invite=INVITA-GOOGLE');

    const res = await volver(flujo, { sub: 'google-nuevo', email: 'otro@aurum.test', email_verified: true });

    expect(destino(res).searchParams.get('reason')).toBe('invite_invalid');
    expect(await countRows('users')).toBe(0);
    expect(await countRows('audit_log', 'event = ?', 'oauth_invite_rejected')).toBe(1);
  });
});

describe('retorno a la APK', () => {
  it('vuelve por el deep link con un vale de un solo uso, nunca con el token', async () => {
    const user = await seedUser({ email: 'movil@aurum.test' });
    const flujo = await iniciar('?client=native');

    const res = await volver(flujo, { sub: 'google-movil', email: 'movil@aurum.test', email_verified: true });

    const url = destino(res);
    expect(url.protocol).toBe('aurum:');
    expect(url.host).toBe('auth');
    expect(url.searchParams.get('auth')).toBe('ok');

    const code = url.searchParams.get('code')!;
    expect(code).toBeTruthy();

    // La sesión todavía no existe: se crea al canjear el vale.
    expect(await countRows('sessions', 'user_id = ?', user.id)).toBe(0);
    expect(await countRows('auth_exchange_codes', 'code_hash = ? AND user_id = ?', await hashToken(code), user.id)).toBe(1);

    // Y el canje sí abre sesión.
    const canje = await dispatch('/api/auth/exchange', {
      method: 'POST',
      headers: { 'X-AURUM-Client': 'native' },
      body: { code },
    });
    expect(canje.status).toBe(200);
    expect((await canje.json<{ token: string }>()).token).toBeTruthy();
  });

  it('los errores del flujo nativo también vuelven por el deep link', async () => {
    const flujo = await iniciar('?client=native');
    const res = await volver(flujo, { sub: 'google-movil', email: 'nadie@aurum.test', email_verified: true });

    const url = destino(res);
    expect(url.protocol).toBe('aurum:');
    expect(url.searchParams.get('reason')).toBe('invite_required');
  });
});
