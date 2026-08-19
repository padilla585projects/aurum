/**
 * Configuración del backend privado.
 *
 * A diferencia de las claves de IA, este token sí vuelve a salir: es el
 * navegador quien llama al backend por la tailnet. Eso lo convierte en el
 * viaje de ida y vuelta que hay que fijar — si el descifrado falla, el
 * endpoint responde `config: null` sin ruido y en la aplicación se ve como si
 * la configuración se hubiera borrado sola.
 */

import { describe, expect, it } from 'vitest';
import { dispatch, seedLoggedIn } from './helpers.ts';

const URL_BACKEND = 'https://aurum-backend.tail2c5046.ts.net';
const TOKEN = 'token-de-prueba-solo-lectura-1234567890';

async function guardar(token: string, body: unknown) {
  return dispatch('/api/backend-config', {
    method: 'PUT',
    bearer: token,
    body: JSON.stringify(body),
  });
}

describe('/api/backend-config', () => {
  it('no responde sin sesión', async () => {
    expect((await dispatch('/api/backend-config')).status).toBe(401);
  });

  it('sin configuración guardada devuelve null, no un error', async () => {
    const { token } = await seedLoggedIn();
    const res = await dispatch('/api/backend-config', { bearer: token });
    expect(res.status).toBe(200);
    expect((await res.json<{ config: unknown }>()).config).toBeNull();
  });

  it('lo que se guarda es lo que se lee después', async () => {
    const { token } = await seedLoggedIn();

    const puesto = await guardar(token, { url: URL_BACKEND, token: TOKEN });
    expect(puesto.status).toBe(200);

    // Esta es la lectura que hace la aplicación al arrancar. Si aquí sale
    // null, los campos de Ajustes aparecen vacíos y parece que se ha borrado.
    const res = await dispatch('/api/backend-config', { bearer: token });
    const { config } = await res.json<{ config: { url: string; apiKey: string } | null }>();
    expect(config).not.toBeNull();
    expect(config!.url).toBe(URL_BACKEND);
    expect(config!.apiKey).toBe(TOKEN);
  });

  it('la barra final no cambia lo que se recupera', async () => {
    const { token } = await seedLoggedIn();
    await guardar(token, { url: `${URL_BACKEND}/`, token: TOKEN });
    const { config } = await (await dispatch('/api/backend-config', { bearer: token }))
      .json<{ config: { url: string } }>();
    expect(config.url).toBe(URL_BACKEND);
  });

  it('guardar dos veces reemplaza, no duplica ni deja lo viejo', async () => {
    const { token } = await seedLoggedIn();
    await guardar(token, { url: URL_BACKEND, token: 'el-viejo' });
    await guardar(token, { url: URL_BACKEND, token: 'el-nuevo' });
    const { config } = await (await dispatch('/api/backend-config', { bearer: token }))
      .json<{ config: { apiKey: string } }>();
    expect(config.apiKey).toBe('el-nuevo');
  });

  it('cada usuario ve la suya y solo la suya', async () => {
    const ana  = await seedLoggedIn({ email: 'ana@aurum.test' });
    const beto = await seedLoggedIn({ email: 'beto@aurum.test' });

    await guardar(ana.token, { url: URL_BACKEND, token: 'token-de-ana' });

    const deBeto = await (await dispatch('/api/backend-config', { bearer: beto.token }))
      .json<{ config: unknown }>();
    expect(deBeto.config).toBeNull();
  });

  it('borrarla la borra de verdad', async () => {
    const { token } = await seedLoggedIn();
    await guardar(token, { url: URL_BACKEND, token: TOKEN });
    expect((await dispatch('/api/backend-config', { method: 'DELETE', bearer: token })).status).toBe(200);
    const { config } = await (await dispatch('/api/backend-config', { bearer: token })).json<{ config: unknown }>();
    expect(config).toBeNull();
  });
});
