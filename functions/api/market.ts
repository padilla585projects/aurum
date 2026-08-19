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

interface Cotizacion { price: number | null; changePct: number | null }

/** Una fuente devuelve la cotización, o lanza si no puede. */
type Fuente = () => Promise<Cotizacion>;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function traerJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Yahoo, `/v8/finance/chart`. El `/v7/finance/quote` que usábamos antes pide
 * galleta y crumb desde hace poco y responde 401 a secas.
 */
function yahoo(host: 'query1' | 'query2', symbol: string): Fuente {
  return async () => {
    const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
    const meta = (await traerJson(url))?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? null;
    const previo = meta?.chartPreviousClose ?? meta?.previousClose ?? null;
    if (price === null) throw new Error('sin precio');
    return { price, changePct: previo ? ((price - previo) / previo) * 100 : null };
  };
}

/** Banco Central Europeo, vía Frankfurter. Solo divisas, sin clave. */
const frankfurter: Fuente = async () => {
  // Se piden los últimos días y se toman los dos últimos con dato: los fines de
  // semana y festivos no publican, así que «ayer» no siempre existe.
  const desde = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const data = await traerJson(`https://api.frankfurter.app/${desde}..?base=EUR&symbols=USD`);
  const dias = Object.keys(data?.rates ?? {}).sort();
  if (dias.length === 0) throw new Error('sin datos');
  const price = data.rates[dias[dias.length - 1]]?.USD ?? null;
  const previo = dias.length > 1 ? data.rates[dias[dias.length - 2]]?.USD ?? null : null;
  if (price === null) throw new Error('sin precio');
  return { price, changePct: previo ? ((price - previo) / previo) * 100 : null };
};

/** CoinGecko. Solo cripto, sin clave, y da la variación ya hecha. */
const coingecko: Fuente = async () => {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=eur&include_24hr_change=true';
  const btc = (await traerJson(url))?.bitcoin;
  if (!btc?.eur) throw new Error('sin precio');
  return { price: btc.eur, changePct: btc.eur_24h_change ?? null };
};

/**
 * Cada símbolo con sus fuentes en orden. Yahoo va primero porque los cubre
 * todos; detrás, su segundo host y —donde existe— una fuente de otra casa.
 * Índices y oro se quedan solo con Yahoo: no encontré ninguna alternativa
 * libre y sin clave que respondiera.
 */
const MARKET_SYMBOLS: { key: string; symbol: string; name: string; currency: string; extra?: Fuente }[] = [
  { key: 'IBEX35', symbol: '^IBEX',    name: 'IBEX 35', currency: 'EUR' },
  { key: 'SP500',  symbol: '^GSPC',    name: 'S&P 500', currency: 'USD' },
  { key: 'NASDAQ', symbol: '^IXIC',    name: 'Nasdaq',  currency: 'USD' },
  { key: 'EURUSD', symbol: 'EURUSD=X', name: 'EUR/USD', currency: 'FX',  extra: frankfurter },
  { key: 'BTCEUR', symbol: 'BTC-EUR',  name: 'Bitcoin', currency: 'EUR', extra: coingecko },
  { key: 'GOLD',   symbol: 'GC=F',     name: 'Oro',     currency: 'USD' },
];

/**
 * Recorre las fuentes de un símbolo hasta que una responda. Es la lección de
 * que Yahoo cerrara su endpoint sin avisar: con una sola fuente, su caída es
 * la nuestra.
 */
async function traerSimbolo(fuentes: Fuente[]): Promise<Cotizacion> {
  for (const fuente of fuentes) {
    try {
      return await fuente();
    } catch {
      // Se prueba la siguiente. Solo importa el fallo de la última.
    }
  }
  throw new Error('ninguna fuente ha respondido');
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  if (!context.data.user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  // Que un símbolo falle no puede tumbar la fila entera: cada uno va por su
  // cuenta y el que no llegue sale en blanco.
  const resultados = await Promise.allSettled(MARKET_SYMBOLS.map(s => traerSimbolo(
    [yahoo('query1', s.symbol), yahoo('query2', s.symbol), ...(s.extra ? [s.extra] : [])],
  )));

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
