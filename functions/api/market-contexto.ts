/**
 * GET /api/market-contexto — dónde está el mercado respecto a donde ha estado.
 *
 * Existe para poder responder «¿está caro o barato ahora?» con números que se
 * pueden comprobar, en vez de preguntándole a un modelo qué le parece. Lo que
 * sale de aquí son cuentas sobre los cierres de los últimos seis meses; el
 * criterio lo pone la IA después, con estos datos delante.
 *
 * No predice nada, y no debe usarse como si lo hiciera.
 */

import type { PagesContext } from '../_lib/types.ts';
import { fail, json } from '../_lib/http.ts';
import { calcularContexto, type ContextoMercado } from '../_lib/mercado.ts';

const REFERENCIAS: { key: string; symbol: string; name: string }[] = [
  { key: 'IBEX35', symbol: '^IBEX', name: 'IBEX 35' },
  { key: 'SP500',  symbol: '^GSPC', name: 'S&P 500' },
  { key: 'NASDAQ', symbol: '^IXIC', name: 'Nasdaq' },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function serieDe(symbol: string): Promise<(number | null)[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=6mo`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);

  const datos = (await res.json()) as {
    chart?: { result?: { indicators?: { quote?: { close?: (number | null)[] }[] } }[] };
  };
  return datos?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { data } = context;
  if (!data.user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  // Cada índice por su cuenta: que uno no responda no puede dejar sin contexto
  // a los demás.
  const resultados = await Promise.allSettled(REFERENCIAS.map(r => serieDe(r.symbol)));

  const contexto: ({ key: string; name: string } & ContextoMercado)[] = [];
  for (let i = 0; i < REFERENCIAS.length; i++) {
    const r = resultados[i];
    if (r.status !== 'fulfilled') continue;
    const calculado = calcularContexto(r.value);
    if (calculado) contexto.push({ key: REFERENCIAS[i].key, name: REFERENCIAS[i].name, ...calculado });
  }

  if (!contexto.length) {
    return fail(502, 'upstream_error', 'No se ha podido calcular el contexto de mercado.');
  }

  // Seis meses de cierres no cambian por horas: media hora de caché ahorra
  // trabajo sin que el dato deje de ser actual.
  return json({ contexto, periodo: '6 meses', ts: Date.now() }, { status: 200 },
    { 'Cache-Control': 'private, max-age=1800' });
}
