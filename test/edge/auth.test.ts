/**
 * Alta, acceso y cierre de sesión.
 *
 * El modelo es registro cerrado: la primera cuenta se crea con el secreto de
 * arranque y todas las demás con invitación. Estas pruebas fijan que esa puerta
 * se cierre sola, que una invitación no se pueda usar dos veces ni con otro
 * correo, y que el token de sesión no se guarde nunca en claro.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PBKDF2_ITERATIONS, hashToken, toBase64Url } from '../../functions/_lib/crypto.ts';
import { countRows, dispatch, passwordHash, seedLoggedIn, seedSession, seedUser } from './helpers.ts';

const SECRETO = 'secreto-de-arranque-de-prueba';
const CLAVE = 'contraseña-larguisima';
const NATIVO = { 'X-AURUM-Client': 'native' };

/** Crea el owner inicial por la vía de arranque y devuelve su sesión. */
async function crearOwner(email = 'owner@aurum.test') {
  const res = await dispatch('/api/auth/register', {
    method: 'POST',
    headers: NATIVO,
    body: { email, password: CLAVE, name: 'Propietario', bootstrapSecret: SECRETO },
  });
  expect(res.status).toBe(200);
  const body = await res.json<{ user: { id: string; role: string }; token: string }>();
  return body;
}

/** Emite una invitación desde la sesión del owner. */
async function emitirInvitacion(token: string, body: Record<string, unknown> = {}) {
  const res = await dispatch('/api/auth/invite', { method: 'POST', bearer: token, body });
  expect(res.status).toBe(200);
  return res.json<{ code: string; role: string; email: string | null; expiresAt: number }>();
}

describe('alta del propietario', () => {
  it('la pantalla de acceso pide crear el owner mientras no haya usuarios', async () => {
    expect(await (await dispatch('/api/auth/config')).json()).toMatchObject({ needsBootstrap: true });
    await crearOwner();
    expect(await (await dispatch('/api/auth/config')).json()).toMatchObject({ needsBootstrap: false });
  });

  it('el secreto de arranque crea la primera cuenta con rol owner', async () => {
    const { user } = await crearOwner();
    expect(user.role).toBe('owner');
    expect(await countRows('users')).toBe(1);
    expect(await countRows('audit_log', 'event = ?', 'register_bootstrap_owner')).toBe(1);
  });

  it('la vía de arranque se cierra en cuanto existe un usuario', async () => {
    await crearOwner();
    const res = await dispatch('/api/auth/register', {
      method: 'POST',
      body: { email: 'segundo@aurum.test', password: CLAVE },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'invite_required' } });
    expect(await countRows('users')).toBe(1);
  });

  it('un secreto de arranque incorrecto no abre nada, y lo dice', async () => {
    const res = await dispatch('/api/auth/register', {
      method: 'POST',
      body: { email: 'intruso@aurum.test', password: CLAVE, bootstrapSecret: 'no-es-el-secreto' },
    });
    expect(res.status).toBe(403);
    // El mensaje tiene que hablar del secreto: caer en el genérico de
    // invitación deja al propietario sin saber qué ha fallado en su propia alta.
    expect(await res.json()).toMatchObject({ error: { code: 'bootstrap_invalid' } });
    expect(await countRows('users')).toBe(0);
    expect(await countRows('audit_log', 'event = ?', 'register_bootstrap_rejected')).toBe(1);
  });

  it('con la instalación ya iniciada, el secreto de arranque explica que llega tarde', async () => {
    await crearOwner();
    const res = await dispatch('/api/auth/register', {
      method: 'POST',
      body: { email: 'tarde@aurum.test', password: CLAVE, bootstrapSecret: SECRETO },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'bootstrap_invalid' } });
    expect(await countRows('users')).toBe(1);
  });

  it('valida correo y contraseña antes de mirar la vía de alta', async () => {
    const correoMalo = await dispatch('/api/auth/register', {
      method: 'POST',
      body: { email: 'sin-arroba', password: CLAVE, bootstrapSecret: SECRETO },
    });
    expect(correoMalo.status).toBe(400);
    expect(await correoMalo.json()).toMatchObject({ error: { code: 'bad_email' } });

    const claveCorta = await dispatch('/api/auth/register', {
      method: 'POST',
      body: { email: 'a@aurum.test', password: 'corta', bootstrapSecret: SECRETO },
    });
    expect(claveCorta.status).toBe(400);
    expect(await claveCorta.json()).toMatchObject({ error: { code: 'weak_password' } });
  });

  it('la web recibe el token solo en la cookie; la APK, también en el cuerpo', async () => {
    const web = await dispatch('/api/auth/register', {
      method: 'POST',
      body: { email: 'web@aurum.test', password: CLAVE, bootstrapSecret: SECRETO },
    });
    const cuerpoWeb = await web.json<{ token?: string }>();
    expect(cuerpoWeb.token).toBeUndefined();
    expect(web.headers.get('Set-Cookie')).toContain('HttpOnly');

    const apk = await dispatch('/api/auth/login', {
      method: 'POST',
      headers: NATIVO,
      body: { email: 'web@aurum.test', password: CLAVE },
    });
    expect((await apk.json<{ token?: string }>()).token).toBeTruthy();
  });

  it('la sesión se guarda hasheada, nunca en claro', async () => {
    const { token } = await crearOwner();
    const fila = await env.DB.prepare('SELECT id FROM sessions').first<{ id: string }>();
    expect(fila?.id).toBe(await hashToken(token));
    expect(fila?.id).not.toBe(token);
  });
});

describe('invitaciones', () => {
  it('solo el propietario las emite', async () => {
    const { token } = await seedLoggedIn({ role: 'user' });
    const res = await dispatch('/api/auth/invite', { method: 'POST', bearer: token, body: {} });
    expect(res.status).toBe(403);
    expect(await countRows('invites')).toBe(0);
  });

  it('el código se muestra una vez y en la tabla solo queda su hash', async () => {
    const owner = await crearOwner();
    const { code } = await emitirInvitacion(owner.token);

    const fila = await env.DB.prepare('SELECT code_hash FROM invites').first<{ code_hash: string }>();
    expect(fila?.code_hash).toBe(await hashToken(code));
    expect(fila?.code_hash).not.toContain(code);
  });

  it('permite registrarse y queda consumida', async () => {
    const owner = await crearOwner();
    const { code } = await emitirInvitacion(owner.token);

    const res = await dispatch('/api/auth/register', {
      method: 'POST',
      body: { email: 'invitado@aurum.test', password: CLAVE, invite: code },
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ user: { role: string } }>()).user.role).toBe('user');
    expect(await countRows('invites', 'used_at IS NOT NULL')).toBe(1);
  });

  it('no se puede usar dos veces', async () => {
    const owner = await crearOwner();
    const { code } = await emitirInvitacion(owner.token);
    await dispatch('/api/auth/register', {
      method: 'POST',
      body: { email: 'primero@aurum.test', password: CLAVE, invite: code },
    });

    const res = await dispatch('/api/auth/register', {
      method: 'POST',
      body: { email: 'segundo@aurum.test', password: CLAVE, invite: code },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'invite_invalid' } });
    expect(await countRows('users')).toBe(2); // owner + primero
  });

  it('una invitación emitida a un correo no sirve para otro', async () => {
    const owner = await crearOwner();
    const { code } = await emitirInvitacion(owner.token, { email: 'esperado@aurum.test' });

    const otro = await dispatch('/api/auth/register', {
      method: 'POST',
      body: { email: 'otro@aurum.test', password: CLAVE, invite: code },
    });
    expect(otro.status).toBe(403);

    const correcto = await dispatch('/api/auth/register', {
      method: 'POST',
      body: { email: 'esperado@aurum.test', password: CLAVE, invite: code },
    });
    expect(correcto.status).toBe(200);
  });

  it('traslada el rol de la invitación a la cuenta creada', async () => {
    const owner = await crearOwner();
    const { code } = await emitirInvitacion(owner.token, { role: 'owner' });

    const res = await dispatch('/api/auth/register', {
      method: 'POST',
      body: { email: 'coowner@aurum.test', password: CLAVE, invite: code },
    });
    expect((await res.json<{ user: { role: string } }>()).user.role).toBe('owner');
  });

  it('rechaza una invitación caducada o inexistente', async () => {
    const owner = await crearOwner();
    await env.DB.prepare(
      `INSERT INTO invites (code_hash, email, role, created_by, created_at, expires_at)
       VALUES (?, NULL, 'user', ?, ?, ?)`,
    ).bind(await hashToken('CADUCADA'), owner.user.id, Date.now() - 100_000, Date.now() - 1_000).run();

    const caducada = await dispatch('/api/auth/register', {
      method: 'POST',
      body: { email: 'tarde@aurum.test', password: CLAVE, invite: 'CADUCADA' },
    });
    expect(caducada.status).toBe(403);

    const inventada = await dispatch('/api/auth/register', {
      method: 'POST',
      body: { email: 'nadie@aurum.test', password: CLAVE, invite: 'NO-EXISTE' },
    });
    expect(inventada.status).toBe(403);
    expect(await countRows('users')).toBe(1);
  });

  it('no deja duplicar un correo ya registrado', async () => {
    const owner = await crearOwner('duplicado@aurum.test');
    const { code } = await emitirInvitacion(owner.token);

    const res = await dispatch('/api/auth/register', {
      method: 'POST',
      body: { email: 'duplicado@aurum.test', password: CLAVE, invite: code },
    });
    expect(res.status).toBe(409);
    // La invitación no se gasta si el alta no llega a producirse.
    expect(await countRows('invites', 'used_at IS NULL')).toBe(1);
  });

  it('el listado del propietario no incluye ningún código', async () => {
    const owner = await crearOwner();
    const { code } = await emitirInvitacion(owner.token, { email: 'alguien@aurum.test' });

    const res = await dispatch('/api/auth/invite', { bearer: owner.token });
    const { invites } = await res.json<{ invites: Record<string, unknown>[] }>();
    expect(invites).toHaveLength(1);
    expect(invites[0]).toMatchObject({ email: 'alguien@aurum.test', role: 'user' });
    expect(JSON.stringify(invites)).not.toContain(code);
  });
});

describe('acceso con contraseña', () => {
  it('entra con las credenciales correctas', async () => {
    const user = await seedUser({ passwordHash: await passwordHash(CLAVE) });
    const res = await dispatch('/api/auth/login', { method: 'POST', body: { email: user.email, password: CLAVE } });

    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('aurum_session=');
    expect((await res.json<{ user: { email: string } }>()).user.email).toBe(user.email);
    expect(await countRows('sessions', 'user_id = ?', user.id)).toBe(1);
  });

  it('responde igual con contraseña incorrecta que con correo inexistente', async () => {
    const user = await seedUser({ passwordHash: await passwordHash(CLAVE) });

    const malaClave = await dispatch('/api/auth/login', {
      method: 'POST',
      body: { email: user.email, password: 'otra-cosa-larga' },
    });
    const noExiste = await dispatch('/api/auth/login', {
      method: 'POST',
      body: { email: 'fantasma@aurum.test', password: CLAVE },
    });

    expect(malaClave.status).toBe(401);
    expect(noExiste.status).toBe(401);
    expect(await malaClave.json()).toEqual(await noExiste.json());
    expect(await countRows('sessions')).toBe(0);
    expect(await countRows('audit_log', 'event = ?', 'login_failed')).toBe(2);
  });

  it('una cuenta solo-Google no entra con contraseña', async () => {
    const user = await seedUser({ passwordHash: null });
    const res = await dispatch('/api/auth/login', { method: 'POST', body: { email: user.email, password: CLAVE } });
    expect(res.status).toBe(401);
  });

  it('una cuenta suspendida se distingue de unas credenciales malas', async () => {
    const user = await seedUser({ passwordHash: await passwordHash(CLAVE), status: 'suspended' });
    const res = await dispatch('/api/auth/login', { method: 'POST', body: { email: user.email, password: CLAVE } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'account_suspended' } });
  });

  it('rechaza un cuerpo vacío o sin campos sin llegar a la base de datos', async () => {
    expect((await dispatch('/api/auth/login', { method: 'POST', body: 'no soy json' })).status).toBe(400);
    expect((await dispatch('/api/auth/login', { method: 'POST', body: {} })).status).toBe(401);
  });

  it('regenera el hash cuando se guardó con menos iteraciones de las actuales', async () => {
    // Hash “antiguo”: mismo algoritmo, coste inferior al vigente.
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(CLAVE), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, key, 256);
    const antiguo = `pbkdf2$sha256$1000$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`;

    const user = await seedUser({ passwordHash: antiguo });
    expect((await dispatch('/api/auth/login', { method: 'POST', body: { email: user.email, password: CLAVE } })).status).toBe(200);

    const fila = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(user.id).first<{ password_hash: string }>();
    expect(Number(fila!.password_hash.split('$')[2])).toBe(PBKDF2_ITERATIONS);
    // Y la contraseña sigue sirviendo tras la regeneración.
    expect((await dispatch('/api/auth/login', { method: 'POST', body: { email: user.email, password: CLAVE } })).status).toBe(200);
  });
});

describe('cierre de sesión', () => {
  it('revoca la sesión actual y deja las demás en pie', async () => {
    const { user, token } = await seedLoggedIn();
    const otroDispositivo = await seedSession(user.id);

    const res = await dispatch('/api/auth/logout', { method: 'POST', bearer: token });
    expect(res.status).toBe(200);
    expect(res.headers.get('Set-Cookie')).toContain('Max-Age=0');

    expect((await dispatch('/api/state', { bearer: token })).status).toBe(401);
    expect((await dispatch('/api/state', { bearer: otroDispositivo })).status).toBe(200);
  });

  it('con ?all=1 cierra todos los dispositivos', async () => {
    const { user, token } = await seedLoggedIn();
    const otroDispositivo = await seedSession(user.id);

    expect((await dispatch('/api/auth/logout?all=1', { method: 'POST', bearer: token })).status).toBe(200);
    expect(await countRows('sessions', 'user_id = ?', user.id)).toBe(0);
    expect((await dispatch('/api/state', { bearer: otroDispositivo })).status).toBe(401);
  });
});

describe('canje del código de la APK', () => {
  /** Inserta un vale de un solo uso como el que emite el retorno de Google. */
  async function sembrarCodigo(userId: string, opts: { expiresAt?: number; consumed?: boolean } = {}) {
    const code = crypto.randomUUID();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO auth_exchange_codes (code_hash, user_id, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(await hashToken(code), userId, now, opts.expiresAt ?? now + 120_000, opts.consumed ? now : null).run();
    return code;
  }

  it('canjea el código por una sesión y devuelve el token a la app', async () => {
    const user = await seedUser();
    const code = await sembrarCodigo(user.id);

    const res = await dispatch('/api/auth/exchange', { method: 'POST', headers: NATIVO, body: { code } });
    expect(res.status).toBe(200);
    const body = await res.json<{ token: string; user: { id: string } }>();
    expect(body.user.id).toBe(user.id);
    expect(body.token).toBeTruthy();

    // El token devuelto abre sesión de verdad.
    expect((await dispatch('/api/auth/me', { bearer: body.token })).status).toBe(200);
  });

  it('el código vale una sola vez', async () => {
    const user = await seedUser();
    const code = await sembrarCodigo(user.id);

    expect((await dispatch('/api/auth/exchange', { method: 'POST', body: { code } })).status).toBe(200);
    const segundo = await dispatch('/api/auth/exchange', { method: 'POST', body: { code } });
    expect(segundo.status).toBe(403);
    expect(await segundo.json()).toMatchObject({ error: { code: 'code_invalid' } });
    expect(await countRows('sessions', 'user_id = ?', user.id)).toBe(1);
  });

  it('rechaza códigos caducados, ya consumidos, inexistentes o de cuentas suspendidas', async () => {
    const user = await seedUser();
    const suspendido = await seedUser({ status: 'suspended' });

    const caducado = await sembrarCodigo(user.id, { expiresAt: Date.now() - 1_000 });
    const consumido = await sembrarCodigo(user.id, { consumed: true });
    const deSuspendido = await sembrarCodigo(suspendido.id);

    for (const code of [caducado, consumido, deSuspendido, 'inventado']) {
      expect((await dispatch('/api/auth/exchange', { method: 'POST', body: { code } })).status).toBe(403);
    }
    expect(await countRows('sessions')).toBe(0);
  });

  it('rechaza la petición sin código', async () => {
    const res = await dispatch('/api/auth/exchange', { method: 'POST', body: {} });
    expect(res.status).toBe(400);
  });
});
