/**
 * Aviso de versión nueva de la aplicación.
 *
 * Lo que fija esta suite es que el vale de descarga sea de verdad un vale: sin
 * él, la APK volvería a estar colgada en una dirección pública, que es
 * justamente lo que se quería evitar al ponerla tras el acceso.
 */

import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch, seedLoggedIn } from './helpers.ts';
import { onRequest as descarga } from '../../functions/descargas/[[ruta]].ts';
import { signPayload } from '../../functions/_lib/crypto.ts';

const VERSION = { versionCode: 10202, versionName: '1.2.2' };

function conManifiesto(hay: boolean, contenido: unknown = VERSION) {
  const original = (env as Record<string, unknown>).ASSETS;
  (env as Record<string, unknown>).ASSETS = {
    fetch: vi.fn(async (peticion: Request | string) => {
      const url = typeof peticion === 'string' ? peticion : peticion.url;
      if (!hay) return new Response('Not Found', { status: 404 });
      if (url.endsWith('version.json')) return Response.json(contenido);
      return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]));
    }),
  };
  return () => { (env as Record<string, unknown>).ASSETS = original; };
}

async function pedirDescarga(consulta: string) {
  const request = new Request(`https://aurum.test/descargas/aurum.apk${consulta}`);
  return descarga({ request, env, data: {}, params: {} } as never);
}

let restaurar: (() => void) | null = null;
afterEach(() => { restaurar?.(); restaurar = null; });

describe('/api/apk-actualizacion', () => {
  it('no dice nada sin sesión', async () => {
    restaurar = conManifiesto(true);
    expect((await dispatch('/api/apk-actualizacion')).status).toBe(401);
  });

  it('devuelve la versión publicada y un enlace con vale', async () => {
    restaurar = conManifiesto(true);
    const { token } = await seedLoggedIn();

    const res = await dispatch('/api/apk-actualizacion', { bearer: token });
    const { publicada } = await res.json<{ publicada: { versionCode:number; versionName:string; url:string } }>();

    expect(publicada.versionCode).toBe(10202);
    expect(publicada.versionName).toBe('1.2.2');
    expect(publicada.url).toContain('/descargas/aurum.apk?t=');
  });

  it('sin nada publicado lo dice, en vez de ofrecer una descarga que no existe', async () => {
    restaurar = conManifiesto(false);
    const { token } = await seedLoggedIn();

    const res = await dispatch('/api/apk-actualizacion', { bearer: token });
    expect((await res.json<{ publicada: unknown }>()).publicada).toBeNull();
  });

  it('un manifiesto ilegible no se da por bueno', async () => {
    const original = (env as Record<string, unknown>).ASSETS;
    (env as Record<string, unknown>).ASSETS = {
      fetch: vi.fn(async () => new Response('esto no es json')),
    };
    restaurar = () => { (env as Record<string, unknown>).ASSETS = original; };

    const { token } = await seedLoggedIn();
    const res = await dispatch('/api/apk-actualizacion', { bearer: token });
    expect((await res.json<{ publicada: unknown }>()).publicada).toBeNull();
  });
});

describe('descarga con vale', () => {
  it('con un vale válido se sirve como aplicación de Android', async () => {
    restaurar = conManifiesto(true);
    const vale = await signPayload(env.AURUM_SIGNING_SECRET, { uso: 'apk' }, 60_000);

    const res = await pedirDescarga(`?t=${encodeURIComponent(vale)}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/vnd.android.package-archive');
  });

  it('sin vale no existe', async () => {
    restaurar = conManifiesto(true);
    expect((await pedirDescarga('')).status).toBe(404);
  });

  it('un vale caducado no existe', async () => {
    restaurar = conManifiesto(true);
    const vale = await signPayload(env.AURUM_SIGNING_SECRET, { uso: 'apk' }, -1000);
    expect((await pedirDescarga(`?t=${encodeURIComponent(vale)}`)).status).toBe(404);
  });

  it('un vale firmado con otro secreto no existe', async () => {
    restaurar = conManifiesto(true);
    const vale = await signPayload('otro-secreto-cualquiera', { uso: 'apk' }, 60_000);
    expect((await pedirDescarga(`?t=${encodeURIComponent(vale)}`)).status).toBe(404);
  });

  it('un vale emitido para otra cosa no sirve aquí', async () => {
    restaurar = conManifiesto(true);
    const vale = await signPayload(env.AURUM_SIGNING_SECRET, { uso: 'oauth' }, 60_000);
    expect((await pedirDescarga(`?t=${encodeURIComponent(vale)}`)).status).toBe(404);
  });
});
