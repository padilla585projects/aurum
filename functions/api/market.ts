/**
 * Cloudflare Worker — proxy de mercado sin autenticación.
 * Devuelve precios en tiempo real de índices, FX, crypto y commodities
 * consultando Yahoo Finance desde el edge (sin problemas de CORS).
 *
 * GET /api/market
 * Respuesta: { data: MarketQuote[], ts: number }
 *
 * Cache-Control: 60 s (respuestas muy recientes las sirve Cloudflare en caché)
 */

interface MarketQuote {
  key:       string;
  name:      string;
  price:     number | null;
  changePct: number | null;
  currency?: string;
}

const MARKET_SYMBOLS: { key: string; symbol: string; name: string; currency: string }[] = [
  { key: 'IBEX35',  symbol: '^IBEX',    name: 'IBEX 35',  currency: 'EUR' },
  { key: 'SP500',   symbol: '^GSPC',    name: 'S&P 500',  currency: 'USD' },
  { key: 'NASDAQ',  symbol: '^IXIC',    name: 'Nasdaq',   currency: 'USD' },
  { key: 'EURUSD',  symbol: 'EURUSD=X', name: 'EUR/USD',  currency: 'FX'  },
  { key: 'BTCEUR',  symbol: 'BTC-EUR',  name: 'Bitcoin',  currency: 'EUR' },
  { key: 'GOLD',    symbol: 'GC=F',     name: 'Oro',      currency: 'USD' },
];

export async function onRequestGet(): Promise<Response> {
  const symbols = MARKET_SYMBOLS.map(s => s.symbol).join(',');
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&fields=regularMarketPrice,regularMarketChangePercent`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      // cf: { cacheTtl: 55 },  // edge cache 55 s
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: `Yahoo HTTP ${res.status}` }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const data: any = await res.json();
    const quotes: any[] = data?.quoteResponse?.result ?? [];

    const result: MarketQuote[] = MARKET_SYMBOLS.map(({ key, symbol, name, currency }) => {
      const q = quotes.find((x: any) => x.symbol === symbol);
      return {
        key,
        name,
        currency,
        price:     q?.regularMarketPrice     ?? null,
        changePct: q?.regularMarketChangePercent ?? null,
      };
    });

    return new Response(JSON.stringify({ data: result, ts: Date.now() }), {
      status: 200,
      headers: {
        'Content-Type':                'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':               'public, max-age=60',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

export async function onRequestOptions(): Promise<Response> {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
