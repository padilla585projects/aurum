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

export async function onRequestGet(context: PagesContext): Promise<Response> {
  if (!context.data.user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  const symbols = MARKET_SYMBOLS.map(s => s.symbol).join(',');
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&fields=regularMarketPrice,regularMarketChangePercent`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'application/json',
      },
    });

    if (!res.ok) return fail(502, 'upstream_error', `Yahoo HTTP ${res.status}`);

    const data = (await res.json()) as { quoteResponse?: { result?: { symbol: string; regularMarketPrice?: number; regularMarketChangePercent?: number }[] } };
    const quotes = data?.quoteResponse?.result ?? [];

    const result: MarketQuote[] = MARKET_SYMBOLS.map(({ key, symbol, name, currency }) => {
      const q = quotes.find(x => x.symbol === symbol);
      return {
        key,
        name,
        currency,
        price: q?.regularMarketPrice ?? null,
        changePct: q?.regularMarketChangePercent ?? null,
      };
    });

    return json({ data: result, ts: Date.now() }, { status: 200 }, { 'Cache-Control': 'private, max-age=60' });
  } catch (err) {
    return fail(502, 'upstream_error', String(err).slice(0, 200));
  }
}
