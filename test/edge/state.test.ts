/**
 * /api/state — el almacén que sustituyó a localStorage.
 *
 * Dos cosas se prueban con especial insistencia: que un usuario no vea ni pise
 * el estado de otro, y que el control de versión detecte la escritura simultánea
 * desde dos dispositivos en lugar de perder datos en silencio.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { countRows, dispatch, seedLoggedIn } from './helpers.ts';

const CLAVE = 'aurum-cartera';

/** Escribe una clave y devuelve la versión resultante. */
async function escribir(token: string, entries: unknown[]): Promise<Response> {
  return dispatch('/api/state', { method: 'PUT', bearer: token, body: { entries } });
}

async function leer(token: string, query = ''): Promise<Record<string, { value: unknown; version: number }>> {
  const res = await dispatch(`/api/state${query}`, { bearer: token });
  expect(res.status).toBe(200);
  return (await res.json<{ state: Record<string, { value: unknown; version: number }> }>()).state;
}

describe('aislamiento entre usuarios', () => {
  it('cada uno solo ve su propio estado', async () => {
    const ana = await seedLoggedIn();
    const bruno = await seedLoggedIn();

    await escribir(ana.token, [{ key: CLAVE, value: { titular: 'ana' } }]);
    await escribir(bruno.token, [{ key: CLAVE, value: { titular: 'bruno' } }]);

    expect((await leer(ana.token))[CLAVE].value).toEqual({ titular: 'ana' });
    expect((await leer(bruno.token))[CLAVE].value).toEqual({ titular: 'bruno' });
  });

  it('borrar una clave no toca la del otro usuario', async () => {
    const ana = await seedLoggedIn();
    const bruno = await seedLoggedIn();
    await escribir(ana.token, [{ key: CLAVE, value: 1 }]);
    await escribir(bruno.token, [{ key: CLAVE, value: 2 }]);

    expect((await dispatch(`/api/state?key=${CLAVE}`, { method: 'DELETE', bearer: ana.token })).status).toBe(200);

    expect(await leer(ana.token)).toEqual({});
    expect((await leer(bruno.token))[CLAVE].value).toBe(2);
  });
});

describe('lectura', () => {
  it('devuelve todo el estado con versión y fecha', async () => {
    const { token } = await seedLoggedIn();
    await escribir(token, [{ key: CLAVE, value: { a: 1 } }, { key: 'aurum-watchlist', value: ['AAPL'] }]);

    const state = await leer(token);
    expect(Object.keys(state).sort()).toEqual(['aurum-cartera', 'aurum-watchlist']);
    expect(state[CLAVE]).toMatchObject({ value: { a: 1 }, version: 1 });
    expect(state[CLAVE]).toHaveProperty('updatedAt');
  });

  it('filtra por las claves pedidas y descarta las que no tienen forma válida', async () => {
    const { token } = await seedLoggedIn();
    await escribir(token, [{ key: CLAVE, value: 1 }, { key: 'aurum-watchlist', value: 2 }]);

    expect(Object.keys(await leer(token, `?keys=${CLAVE}`))).toEqual([CLAVE]);
    expect(await leer(token, '?keys=otra-cosa,../etc/passwd')).toEqual({});
  });

  it('una fila con JSON corrupto devuelve null en vez de tumbar la lectura', async () => {
    const { user, token } = await seedLoggedIn();
    await env.DB.prepare(
      `INSERT INTO user_state (user_id, key, value, version, size, updated_at) VALUES (?, ?, '{no es json', 1, 11, ?)`,
    ).bind(user.id, CLAVE, Date.now()).run();

    expect((await leer(token))[CLAVE].value).toBeNull();
  });
});

describe('escritura y versiones', () => {
  it('crea en la versión 1 y sube una por cada escritura', async () => {
    const { token } = await seedLoggedIn();

    const primera = await escribir(token, [{ key: CLAVE, value: { v: 1 } }]);
    expect(await primera.json()).toMatchObject({ results: { [CLAVE]: 1 } });

    const segunda = await escribir(token, [{ key: CLAVE, value: { v: 2 } }]);
    expect(await segunda.json()).toMatchObject({ results: { [CLAVE]: 2 } });
  });

  it('acepta la escritura que declara la versión que leyó', async () => {
    const { token } = await seedLoggedIn();
    await escribir(token, [{ key: CLAVE, value: { v: 1 } }]);

    const res = await escribir(token, [{ key: CLAVE, value: { v: 2 }, version: 1 }]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ results: { [CLAVE]: 2 } });
  });

  it('rechaza con 409 la escritura de un dispositivo que se quedó atrás', async () => {
    const { token } = await seedLoggedIn();
    await escribir(token, [{ key: CLAVE, value: { v: 1 } }]);
    await escribir(token, [{ key: CLAVE, value: { v: 2 } }]); // otro dispositivo

    const res = await escribir(token, [{ key: CLAVE, value: { v: 3 }, version: 1 }]);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'version_conflict' } });
    expect(res.headers.get('X-Conflict-Keys')).toBe(CLAVE);

    // El valor bueno sigue siendo el del otro dispositivo.
    expect((await leer(token))[CLAVE].value).toEqual({ v: 2 });
  });

  it('una clave nueva declarando versión 0 se acepta', async () => {
    const { token } = await seedLoggedIn();
    expect((await escribir(token, [{ key: CLAVE, value: 1, version: 0 }])).status).toBe(200);
  });

  it('o entra todo el lote o no entra nada', async () => {
    const { user, token } = await seedLoggedIn();
    await escribir(token, [{ key: CLAVE, value: { v: 1 } }]);

    // La segunda clave del lote llega con versión obsoleta.
    const res = await escribir(token, [
      { key: 'aurum-watchlist', value: ['nueva'] },
      { key: CLAVE, value: { v: 9 }, version: 0 },
    ]);
    expect(res.status).toBe(409);
    expect(await countRows('user_state', 'user_id = ?', user.id)).toBe(1);
  });

  it('un lote vacío no es un error', async () => {
    const { token } = await seedLoggedIn();
    const res = await escribir(token, []);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: {} });
  });
});

describe('validación y cuotas', () => {
  it('rechaza claves fuera del formato admitido', async () => {
    const { token } = await seedLoggedIn();
    for (const key of ['otra-cosa', 'aurum-MAYUSCULAS', 'aurum-', `aurum-${'x'.repeat(61)}`, 42, null]) {
      const res = await escribir(token, [{ key, value: 1 }]);
      expect(res.status, `clave ${String(key)}`).toBe(400);
      expect(await res.json()).toMatchObject({ error: { code: 'bad_key' } });
    }
  });

  it('exige un valor, aunque sea null', async () => {
    const { token } = await seedLoggedIn();
    expect((await escribir(token, [{ key: CLAVE }])).status).toBe(400);
    expect((await escribir(token, [{ key: CLAVE, value: null }])).status).toBe(200);
  });

  it('rechaza un cuerpo que no tenga la forma esperada', async () => {
    const { token } = await seedLoggedIn();
    const res = await dispatch('/api/state', { method: 'PUT', bearer: token, body: { otra: 'cosa' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('limita el número de claves por escritura', async () => {
    const { token } = await seedLoggedIn();
    const entries = Array.from({ length: 33 }, (_, i) => ({ key: `aurum-k${i}`, value: i }));
    const res = await escribir(token, entries);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'too_many_entries' } });
  });

  it('rechaza un valor que supera el límite por clave', async () => {
    const { token } = await seedLoggedIn();
    const res = await escribir(token, [{ key: CLAVE, value: 'x'.repeat(257 * 1024) }]);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'value_too_large' } });
  });

  it('rechaza cuando se supera el espacio total del usuario', async () => {
    const { user, token } = await seedLoggedIn();
    // Se simula el espacio ya ocupado sin escribir megabytes de verdad: la cuota
    // se calcula sobre la columna `size`.
    await env.DB.prepare(
      `INSERT INTO user_state (user_id, key, value, version, size, updated_at) VALUES (?, 'aurum-relleno', '""', 1, ?, ?)`,
    ).bind(user.id, 4 * 1024 * 1024 - 10, Date.now()).run();

    const res = await escribir(token, [{ key: CLAVE, value: 'x'.repeat(1024) }]);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'quota_exceeded' } });
  });

  it('rechaza cuando se supera el número de claves del usuario', async () => {
    const { user, token } = await seedLoggedIn();
    const relleno = Array.from({ length: 64 }, (_, i) =>
      env.DB.prepare(
        `INSERT INTO user_state (user_id, key, value, version, size, updated_at) VALUES (?, ?, '1', 1, 1, ?)`,
      ).bind(user.id, `aurum-relleno-${i}`, Date.now()),
    );
    await env.DB.batch(relleno);

    const res = await escribir(token, [{ key: CLAVE, value: 1 }]);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'too_many_keys' } });

    // Reescribir una clave que ya existe sigue permitido: no añade ninguna.
    expect((await escribir(token, [{ key: 'aurum-relleno-0', value: 2 }])).status).toBe(200);
  });
});

describe('borrado', () => {
  it('borra la clave pedida', async () => {
    const { token } = await seedLoggedIn();
    await escribir(token, [{ key: CLAVE, value: 1 }, { key: 'aurum-watchlist', value: 2 }]);

    expect((await dispatch(`/api/state?key=${CLAVE}`, { method: 'DELETE', bearer: token })).status).toBe(200);
    expect(Object.keys(await leer(token))).toEqual(['aurum-watchlist']);
  });

  it('exige una clave con formato válido', async () => {
    const { token } = await seedLoggedIn();
    expect((await dispatch('/api/state', { method: 'DELETE', bearer: token })).status).toBe(400);
    expect((await dispatch('/api/state?key=otra-cosa', { method: 'DELETE', bearer: token })).status).toBe(400);
  });
});
