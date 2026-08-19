/**
 * Middleware de /api.
 *
 * Ninguna ruta de /api responde sin pasar por aquí, así que este fichero es el
 * que comprueba las cuatro garantías transversales: hace falta sesión, el CORS
 * no se abre a cualquiera, una escritura autenticada por cookie exige origen
 * conocido, y los límites cortan antes de llegar al handler.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../functions/_lib/types.ts';
import { LIMITS } from '../../functions/_lib/ratelimit.ts';
import { countRows, dispatch, seedLoggedIn, seedSession, seedUser } from './helpers.ts';

const AJENO = 'https://evil.test';

describe('configuración incompleta', () => {
  it('falla en voz alta si no hay binding de D1', async () => {
    const res = await dispatch('/api/auth/config', { envOverrides: { DB: undefined } as unknown as Partial<Env> });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'no_database' } });
  });

  it('falla en voz alta si no hay secreto de firma', async () => {
    const res = await dispatch('/api/auth/config', { envOverrides: { AURUM_SIGNING_SECRET: '' } });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'no_signing_secret' } });
  });
});

describe('autenticación', () => {
  it('las rutas públicas responden sin sesión', async () => {
    expect((await dispatch('/api/auth/config')).status).toBe(200);
  });

  it('el resto exige sesión', async () => {
    const res = await dispatch('/api/state');
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'unauthenticated' } });
  });

  it('un token inventado no vale', async () => {
    expect((await dispatch('/api/state', { bearer: 'token-inventado' })).status).toBe(401);
  });

  it('una sesión caducada se rechaza y se borra de la tabla', async () => {
    const user = await seedUser();
    const token = await seedSession(user.id, { expiresAt: Date.now() - 1_000 });

    expect((await dispatch('/api/state', { bearer: token })).status).toBe(401);
    expect(await countRows('sessions', 'user_id = ?', user.id)).toBe(0);
  });

  it('una cuenta suspendida no entra, aunque su sesión siga viva', async () => {
    const { token, user } = await seedLoggedIn({ status: 'suspended' });
    expect((await dispatch('/api/state', { bearer: token })).status).toBe(401);
    // La sesión no se borra: la cuenta puede reactivarse.
    expect(await countRows('sessions', 'user_id = ?', user.id)).toBe(1);
  });

  it('deja el usuario disponible para el handler', async () => {
    const { user, token } = await seedLoggedIn();
    const res = await dispatch('/api/auth/me', { bearer: token });
    expect(await res.json()).toEqual({ user: { id: user.id, email: user.email, name: null, role: 'user', status: 'active' } });
  });
});

describe('CORS', () => {
  it('responde al preflight de un origen de la allowlist', async () => {
    const res = await dispatch('/api/state', { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://aurum.test');
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
  });

  it('acepta el preflight de la aplicación nativa', async () => {
    const res = await dispatch('/api/state', { method: 'OPTIONS', origin: 'capacitor://localhost' });
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('capacitor://localhost');
  });

  it('rechaza el preflight de un origen ajeno', async () => {
    const res = await dispatch('/api/state', { method: 'OPTIONS', origin: AJENO });
    expect(res.status).toBe(403);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('no devuelve cabeceras CORS a un origen ajeno, ni siquiera en una respuesta correcta', async () => {
    const { token } = await seedLoggedIn();
    const res = await dispatch('/api/auth/me', { bearer: token, origin: AJENO });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('Vary')).toBe('Origin');
  });
});

describe('CSRF', () => {
  it('bloquea una escritura con cookie desde un origen ajeno y lo registra', async () => {
    const { token, user } = await seedLoggedIn();
    const res = await dispatch('/api/state', {
      method: 'PUT',
      cookie: token,
      origin: AJENO,
      body: { entries: [{ key: 'aurum-cartera', value: { a: 1 } }] },
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: 'bad_origin' } });
    expect(await countRows('audit_log', 'event = ? AND user_id = ?', 'csrf_blocked', user.id)).toBe(1);
    expect(await countRows('user_state', 'user_id = ?', user.id)).toBe(0);
  });

  it('deja pasar la misma escritura desde el origen propio', async () => {
    const { token } = await seedLoggedIn();
    const res = await dispatch('/api/state', {
      method: 'PUT',
      cookie: token,
      body: { entries: [{ key: 'aurum-cartera', value: { a: 1 } }] },
    });
    expect(res.status).toBe(200);
  });

  it('no aplica a la APK, que se identifica con Authorization', async () => {
    const { token } = await seedLoggedIn();
    // El navegador nunca adjunta esta cabecera solo, así que no hay CSRF posible.
    const res = await dispatch('/api/state', {
      method: 'PUT',
      bearer: token,
      origin: AJENO,
      body: { entries: [{ key: 'aurum-cartera', value: { a: 1 } }] },
    });
    expect(res.status).toBe(200);
  });

  it('no bloquea las lecturas', async () => {
    const { token } = await seedLoggedIn();
    expect((await dispatch('/api/state', { cookie: token, origin: AJENO })).status).toBe(200);
  });
});

describe('límite de peticiones', () => {
  /** Deja el cubo de la ventana actual justo en su máximo. */
  async function agotarCubo(subject: string, name: string): Promise<void> {
    const windowMs = LIMITS[name].windowSeconds * 1000;
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    await env.DB.prepare(
      'INSERT INTO rate_limits (bucket, count, window_start, expires_at) VALUES (?, ?, ?, ?)',
    ).bind(`${subject}:${name}:${windowStart}`, LIMITS[name].max, windowStart, windowStart + windowMs).run();
  }

  it('corta con 429 y Retry-After cuando se supera, y lo registra', async () => {
    await agotarCubo('ip:198.51.100.7', 'auth:login');

    const res = await dispatch('/api/auth/login', {
      method: 'POST',
      body: { email: 'alguien@aurum.test', password: 'contraseña-larguisima' },
    });

    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: { code: 'rate_limited' } });
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0);
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    expect(await countRows('audit_log', 'event = ?', 'rate_limited')).toBe(1);
  });

  it('el cubo va por usuario cuando hay sesión, no por IP', async () => {
    const { user, token } = await seedLoggedIn();
    await agotarCubo(`u:${user.id}`, 'state:read');

    expect((await dispatch('/api/state', { bearer: token })).status).toBe(429);

    // Otro usuario desde la misma IP no arrastra el castigo.
    const otro = await seedLoggedIn();
    expect((await dispatch('/api/state', { bearer: otro.token })).status).toBe(200);
  });

  it('lectura y escritura de estado tienen cubos distintos', async () => {
    const { user, token } = await seedLoggedIn();
    await agotarCubo(`u:${user.id}`, 'state:read');

    expect((await dispatch('/api/state', { bearer: token })).status).toBe(429);
    expect((await dispatch('/api/state', { method: 'PUT', bearer: token, body: { entries: [] } })).status).toBe(200);
  });
});

describe('errores del handler', () => {
  it('un fallo sin capturar se convierte en 500 genérico y queda auditado', async () => {
    const { token } = await seedLoggedIn();
    // Un binding que falla al consultar el estado revienta dentro del handler,
    // ya pasado el middleware. La auditoría del error sí usa la D1 real.
    const fallo = {
      bind: () => fallo,
      all: () => Promise.reject(new Error('boom')),
      first: () => Promise.reject(new Error('boom')),
      run: () => Promise.reject(new Error('boom')),
    };
    const dbRoto = {
      prepare: (sql: string) => (sql.includes('user_state') ? fallo : env.DB.prepare(sql)),
    };
    const res = await dispatch('/api/state', {
      bearer: token,
      envOverrides: { DB: dbRoto } as unknown as Partial<Env>,
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error: { code: 'internal_error' } });
    // El mensaje del error no se filtra al cliente, pero sí se guarda.
    expect(await countRows('audit_log', 'event = ?', 'unhandled_error')).toBe(1);
  });
});
