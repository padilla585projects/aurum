/**
 * GET /api/market — precios de índices, FX, crypto y materias primas.
 *
 * Consulta Yahoo Finance desde el edge para evitar problemas de CORS. Requiere
 * sesión, como el resto de /api: aunque el dato no es sensible, un endpoint
 * abierto es tráfico gratuito para terceros a costa del proyecto.
 *
 * La caché es `private`: la respuesta es idéntica para todos los usuarios, pero
 * marcarla como `public` permitiría que una caché intermedia la sirviera a
 * peticiones que no han pasado por el control de sesión.
 */

import type { PagesContext } from '../_lib/types.ts';
import { fail, json } from '../_lib/http.ts';

interface MarketQuote {
  key: string;
  name: string;
  price: number | null;
  changePct: number | null;
  currency?: string;
}

const MARKET_SYMBOLS: { key: string; symbol: string; name: string; currency: string }[] = [
  { key: 'IBEX35', symbol: '^IBEX',    name: 'IBEX 35', currency: 'EUR' },
  { key: 'SP500',  symbol: '^GSPC',    name: 'S&P 500', currency: 'USD' },
  { key: 'NASDAQ', symbol: '^IXIC',    name: 'Nasdaq',  currency: 'USD' },
  { key: 'EURUSD', symbol: 'EURUSD=X', name: 'EUR/USD', currency: 'FX'  },
  { key: 'BTCEUR', symbol: 'BTC-EUR',  name: 'Bitcoin', currency: 'EUR' },
  { key: 'GOLD',   symbol: 'GC=F',     name: 'Oro',     currency: 'USD' },
];

/**
 * Trae un símbolo. Yahoo cerró `/v7/finance/quote` —responde 401 sin galleta ni
 * crumb—, así que se usa `/v8/finance/chart`, que sigue abierto. La contrapartida
 * es que va de uno en uno, de ahí las seis peticiones en paralelo.
 */
async function traerSimbolo(symbol: string): Promise<{ price: number | null; changePct: number | null }> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);

  const data = (await res.json()) as {
    chart?: { result?: { meta?: { regularMarketPrice?: number; chartPreviousClose?: number; previousClose?: number } }[] };
  };
  const meta = data?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice ?? null;
  const previo = meta?.chartPreviousClose ?? meta?.previousClose ?? null;

  // La variación ya no viene dada: se calcula contra el cierre anterior. Sin él
  // se devuelve el precio igualmente, que es mejor que no devolver nada.
  const changePct = price !== null && previo ? ((price - previo) / previo) * 100 : null;
  return { price, changePct };
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  if (!context.data.user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  // Que un símbolo falle no puede tumbar la fila entera: cada uno va por su
  // cuenta y el que no llegue sale en blanco.
  const resultados = await Promise.allSettled(MARKET_SYMBOLS.map(s => traerSimbolo(s.symbol)));

  const result: MarketQuote[] = MARKET_SYMBOLS.map(({ key, name, currency }, i) => {
    const r = resultados[i];
    return {
      key,
      name,
      currency,
      price:     r.status === 'fulfilled' ? r.value.price     : null,
      changePct: r.status === 'fulfilled' ? r.value.changePct : null,
    };
  });

  if (result.every(q => q.price === null)) {
    return fail(502, 'upstream_error', 'Yahoo no ha devuelto ninguna cotización.');
  }

  return json({ data: result, ts: Date.now() }, { status: 200 }, { 'Cache-Control': 'private, max-age=60' });
}
