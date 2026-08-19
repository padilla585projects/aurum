/**
 * Límite de peticiones por ventana fija sobre D1.
 *
 * Es la superficie que frena la prueba de contraseñas y de códigos de
 * invitación, así que importa tanto que corte al superar el máximo como que un
 * fallo de la base de datos no deje la aplicación inutilizable.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../functions/_lib/types.ts';
import { LIMITS, consume, limitHeaders, sweep } from '../../functions/_lib/ratelimit.ts';

describe('consume', () => {
  it('deja pasar hasta el máximo y corta a partir de ahí', async () => {
    const max = LIMITS['auth:login'].max;
    for (let i = 1; i <= max; i++) {
      const result = await consume(env, 'ip:203.0.113.1', 'auth:login');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(max - i);
    }

    const cortada = await consume(env, 'ip:203.0.113.1', 'auth:login');
    expect(cortada.allowed).toBe(false);
    expect(cortada.remaining).toBe(0);
    expect(cortada.retryAfter).toBeGreaterThan(0);
    expect(cortada.retryAfter).toBeLessThanOrEqual(LIMITS['auth:login'].windowSeconds);
  });

  it('cuenta por sujeto, no de forma global', async () => {
    for (let i = 0; i < LIMITS['auth:login'].max + 1; i++) {
      await consume(env, 'ip:203.0.113.1', 'auth:login');
    }
    expect((await consume(env, 'ip:203.0.113.2', 'auth:login')).allowed).toBe(true);
  });

  it('cuenta por cubo, no mezcla rutas del mismo sujeto', async () => {
    for (let i = 0; i < LIMITS['auth:login'].max + 1; i++) {
      await consume(env, 'u:alguien', 'auth:login');
    }
    expect((await consume(env, 'u:alguien', 'state:write')).allowed).toBe(true);
  });

  it('una ruta sin límite declarado pasa siempre', async () => {
    const result = await consume(env, 'u:alguien', 'ruta:inexistente');
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(0);
  });

  it('si D1 falla se deja pasar la petición en lugar de bloquear la aplicación', async () => {
    const roto = {
      DB: {
        prepare() {
          throw new Error('D1 caída');
        },
      },
    } as unknown as Env;
    const result = await consume(roto, 'u:alguien', 'auth:login');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(LIMITS['auth:login'].max);
  });

  it('la ventana es fija: el cubo lleva su inicio en la clave', async () => {
    await consume(env, 'u:ventana', 'market');
    const windowMs = LIMITS.market.windowSeconds * 1000;
    const esperado = `u:ventana:market:${Math.floor(Date.now() / windowMs) * windowMs}`;
    const row = await env.DB.prepare('SELECT count FROM rate_limits WHERE bucket = ?').bind(esperado).first<{ count: number }>();
    expect(row?.count).toBe(1);
  });
});

describe('limitHeaders', () => {
  it('solo añade Retry-After cuando la petición se rechaza', () => {
    expect(limitHeaders({ allowed: true, remaining: 3, retryAfter: 60, limit: 10 })).toEqual({
      'X-RateLimit-Limit': '10',
      'X-RateLimit-Remaining': '3',
    });
    expect(limitHeaders({ allowed: false, remaining: 0, retryAfter: 60, limit: 10 })['Retry-After']).toBe('60');
  });
});

describe('sweep', () => {
  it('borra los cubos y las sesiones caducadas, y respeta los vigentes', async () => {
    const ahora = Date.now();
    // D1 sí aplica las claves ajenas: sin usuario no se puede insertar sesión.
    await env.DB.prepare(
      `INSERT INTO users (id, email, email_verified, role, status, created_at)
       VALUES ('u1', 'sweep@aurum.test', 0, 'user', 'active', ?)`,
    ).bind(ahora).run();

    await env.DB.batch([
      env.DB.prepare('INSERT INTO rate_limits (bucket, count, window_start, expires_at) VALUES (?, 1, ?, ?)')
        .bind('viejo', ahora - 10_000, ahora - 1_000),
      env.DB.prepare('INSERT INTO rate_limits (bucket, count, window_start, expires_at) VALUES (?, 1, ?, ?)')
        .bind('vigente', ahora, ahora + 60_000),
      env.DB.prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES ('caducada', 'u1', ?, ?, ?)`,
      ).bind(ahora - 10_000, ahora - 1_000, ahora - 10_000),
      env.DB.prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES ('viva', 'u1', ?, ?, ?)`,
      ).bind(ahora, ahora + 60_000, ahora),
    ]);

    await sweep(env);

    const cubos = await env.DB.prepare('SELECT bucket FROM rate_limits').all<{ bucket: string }>();
    expect(cubos.results.map(r => r.bucket)).toEqual(['vigente']);
    const sesiones = await env.DB.prepare('SELECT id FROM sessions').all<{ id: string }>();
    expect(sesiones.results.map(r => r.id)).toEqual(['viva']);
  });
});
