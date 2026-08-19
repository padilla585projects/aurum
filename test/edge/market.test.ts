/**
 * Cotizaciones de cabecera.
 *
 * Yahoo cerró `/v7/finance/quote` sin avisar y la fila se quedó en blanco para
 * todo el mundo. Lo que fija esta suite no es el proveedor —ese puede volver a
 * cambiar— sino la propiedad que evita que un corte se lleve la pantalla: un
 * símbolo que falla sale vacío, los demás siguen saliendo.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch, seedLoggedIn } from './helpers.ts';

/** Respuesta de Yahoo v8 recortada a lo que se lee de ella. */
function chart(precio: number, previo: number) {
  return new Response(
    JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: precio, chartPreviousClose: previo } }] } }),
    { headers: { 'Content-Type': 'application/json' } },
  );
}

interface Cotizacion { key: string; price: number | null; changePct: number | null }

async function pedirMercado(token: string) {
  const res = await dispatch('/api/market', { bearer: token });
  return { status: res.status, cuerpo: await res.json<{ data?: Cotizacion[] }>() };
}

afterEach(() => vi.unstubAllGlobals());

describe('/api/market', () => {
  it('no responde sin sesión', async () => {
    expect((await dispatch('/api/market')).status).toBe(401);
  });

  it('devuelve los seis símbolos con su variación calculada', async () => {
    const { token } = await seedLoggedIn();
    vi.stubGlobal('fetch', vi.fn(async () => chart(110, 100)));

    const { status, cuerpo } = await pedirMercado(token);
    expect(status).toBe(200);
    expect(cuerpo.data).toHaveLength(6);
    for (const q of cuerpo.data!) {
      expect(q.price).toBe(110);
      // Yahoo ya no da el porcentaje: sale de comparar con el cierre anterior.
      expect(q.changePct).toBeCloseTo(10, 5);
    }
  });

  it('usa /v8/finance/chart, que es el que sigue abierto', async () => {
    const { token } = await seedLoggedIn();
    const espia = vi.fn(async () => chart(1, 1));
    vi.stubGlobal('fetch', espia);

    await pedirMercado(token);
    const urls = espia.mock.calls.map(c => String(c[0]));
    expect(urls).toHaveLength(6);
    expect(urls.every(u => u.includes('/v8/finance/chart/'))).toBe(true);
    expect(urls.some(u => u.includes('/v7/finance/quote'))).toBe(false);
  });

  it('un símbolo caído no tumba a los demás', async () => {
    const { token } = await seedLoggedIn();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      n += 1;
      return n === 1 ? new Response('', { status: 401 }) : chart(50, 50);
    }));

    const { status, cuerpo } = await pedirMercado(token);
    expect(status).toBe(200);
    expect(cuerpo.data![0].price).toBeNull();
    expect(cuerpo.data!.slice(1).every(q => q.price === 50)).toBe(true);
  });

  it('sin cierre anterior se devuelve el precio y la variación en blanco', async () => {
    const { token } = await seedLoggedIn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 42 } }] } }),
      { headers: { 'Content-Type': 'application/json' } },
    )));

    const { cuerpo } = await pedirMercado(token);
    expect(cuerpo.data![0].price).toBe(42);
    expect(cuerpo.data![0].changePct).toBeNull();
  });

  it('si no llega ninguna cotización se dice, en vez de devolver seis huecos', async () => {
    const { token } = await seedLoggedIn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));

    expect((await pedirMercado(token)).status).toBe(502);
  });
});
