/**
 * Descarga de la aplicación para Android.
 *
 * La APK tiene que existir como fichero estático para poder servirla, y eso la
 * dejaría colgando en una dirección pública. Lo que se fija aquí es que la
 * única puerta sea la que pide sesión.
 */

import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch, seedLoggedIn } from './helpers.ts';
import { onRequest as sinAcceso } from '../../functions/descargas/[[ruta]].ts';

/** Almacén de estáticos de mentira, con o sin la APK dentro. */
function conFicheros(hayApk: boolean) {
  const original = (env as Record<string, unknown>).ASSETS;
  (env as Record<string, unknown>).ASSETS = {
    fetch: vi.fn(async () => hayApk
      ? new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))  // cabecera de un zip
      : new Response('Not Found', { status: 404 })),
  };
  return () => { (env as Record<string, unknown>).ASSETS = original; };
}

let restaurar: (() => void) | null = null;
afterEach(() => { restaurar?.(); restaurar = null; });

describe('/api/apk', () => {
  it('no se descarga sin sesión', async () => {
    restaurar = conFicheros(true);
    expect((await dispatch('/api/apk')).status).toBe(401);
  });

  it('con sesión se sirve como aplicación de Android', async () => {
    restaurar = conFicheros(true);
    const { token } = await seedLoggedIn();

    const res = await dispatch('/api/apk', { bearer: token });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/vnd.android.package-archive');
    expect(res.headers.get('Content-Disposition')).toContain('aurum.apk');
    // Privada: ninguna caché intermedia debe guardarla para otro.
    expect(res.headers.get('Cache-Control')).toContain('private');
  });

  it('si todavía no hay ninguna versión se dice, en vez de servir un vacío', async () => {
    restaurar = conFicheros(false);
    const { token } = await seedLoggedIn();

    const res = await dispatch('/api/apk', { bearer: token });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
  });

  it('la ruta del fichero no se puede pedir directamente', async () => {
    // Es la mitad que hace que lo anterior sirva de algo: sin esto, la APK
    // seguiría descargándose sin sesión por su dirección estática.
    expect(sinAcceso().status).toBe(404);
  });
});
