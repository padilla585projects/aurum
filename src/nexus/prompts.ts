import type { AgentKey, Position, UserProfile } from './types';
import type { ContextSelection } from './context';

// ── Grouped sources — only include what's relevant per agent + intent ─────────
const SRC = {
  prices:    'Precios: finance.yahoo.com, investing.com, marketwatch.com',
  news_es:   'Noticias ES: expansion.com, cincodias.elpais.com, eleconomista.es',
  news_en:   'Noticias EN: reuters.com, bloomberg.com, ft.com',
  etf:       'ETFs: justetf.com, etfdb.com, morningstar.es',
  analysis:  'Análisis: seekingalpha.com, tipranks.com, zacks.com',
  macro:     'Macro: ecb.europa.eu, federalreserve.gov, bde.es, ine.es',
  crypto:    'Cripto: coinmarketcap.com, coingecko.com',
  spain_reg: 'Fiscal: aeat.es, boe.es, cnmv.es',
} as const;
type SrcKey = keyof typeof SRC;

function buildSources(agentKey: AgentKey, ctx: ContextSelection): string {
  if (!ctx.useWebSearch) return '';

  const q         = ctx.query.toLowerCase();
  const hasCrypto = /bitcoin|\bbtc\b|ethereum|\beth\b|cripto|altcoin/.test(q);

  let keys: SrcKey[] = [];
  switch (agentKey) {
    case 'aurum':
      keys = ['prices', 'news_es', 'etf'];
      if (ctx.intent === 'comprehensive' || ctx.intent === 'analytical') keys.push('analysis');
      if (ctx.intent === 'comprehensive') keys.push('news_en');
      break;
    case 'macro':
      keys = ['prices', 'news_es', 'news_en', 'macro'];
      break;
    case 'fiscal':
      keys = ['spain_reg', 'news_es'];
      break;
    case 'riesgo':
      return '';
  }

  if (hasCrypto && agentKey !== 'fiscal') keys.push('crypto');

  return `\nFuentes: ${keys.map(k => SRC[k]).join(' · ')}\nPrioriza datos actuales.`;
}

export const PROFILES: Record<string, { label: string; emoji: string; color: string; alloc: string; sys: string }> = {
  conservador: {
    label: 'Conservador', emoji: '🛡️', color: '#5b9cf6',
    alloc: '70% RF · 20% RV · 10% Alt.',
    sys: 'CONSERVADOR: preservar capital. Máx 25% RV (ETFs low-vol, dividendos). Resto RF (bonos AAA, monetarios). Sin cripto.',
  },
  moderado: {
    label: 'Moderado', emoji: '⚖️', color: '#c9a84c',
    alloc: '40% RF · 50% RV · 10% Alt.',
    sys: 'MODERADO: equilibrio rentabilidad-seguridad. Core ETFs globales (MSCI World, S&P500). Colchón RF. Mínima exposición alternativos.',
  },
  agresivo: {
    label: 'Agresivo', emoji: '🚀', color: '#e05252',
    alloc: '10% RF · 75% RV · 15% Alt.',
    sys: 'AGRESIVO: maximizar rentabilidad, alta volatilidad aceptada. RV global, acciones, ETFs temáticos, REITs, hasta 15% cripto. Horizonte mín. 10 años.',
  },
};

export function buildUserBlock(up: UserProfile): string {
  const lines: string[] = [];
  if (up.name)    lines.push(`Usuario: ${up.name}`);
  if (up.age)     lines.push(`Edad: ${up.age}a`);
  if (up.capital) lines.push(`Capital: ${up.capital}€`);
  if (up.income)  lines.push(`Ingresos: ${up.income}€/año`);
  if (up.horizon) lines.push(`Horizonte: ${up.horizon}`);
  if (up.broker)  lines.push(`Broker: ${up.broker}`);
  if (up.country) lines.push(`País fiscal: ${up.country}`);
  if (up.notes)   lines.push(`Notas: ${up.notes}`);
  if (!lines.length) return '';
  return `\n\n## Perfil usuario\n${lines.join(' · ')}`;
}

function portfolioBlock(portfolio: Position[]): string {
  const total = portfolio.reduce((a, p) => a + p.shares * p.currentPrice, 0);
  const rows  = portfolio.map(p => {
    const pnl = ((p.currentPrice - p.avgPrice) / p.avgPrice * 100).toFixed(1);
    return `${p.ticker}(${p.shares}@${p.avgPrice}→${p.currentPrice}€,${+pnl >= 0 ? '+' : ''}${pnl}%)`;
  }).join(' ');
  return `\n\n## Cartera\n${rows}\nTotal: ${total.toFixed(0)}€`;
}

function contextBlock(ctx: ContextSelection): string {
  let out = '';
  if (ctx.portfolio) out += portfolioBlock(ctx.portfolio);
  if (ctx.user)      out += buildUserBlock(ctx.user);
  if (ctx.facts.length) out += `\n\n## Contexto relevante\n${ctx.facts.map(f => `- ${f}`).join('\n')}`;
  return out;
}

// ── Agent system prompts ────────────────────────────────────────────────────

export function buildAurumPrompt(profile: string, ctx: ContextSelection): string {
  const pf      = PROFILES[profile];
  const sources = buildSources('aurum', ctx);

  let prompt = ctx.intent === 'simple'
    ? `Eres AURUM, asesor de inversión experto. Perfil ${pf.label}: ${pf.sys}`
    : `Eres AURUM, asesor de inversión CFA. Experto en ETFs, fondos indexados, RV, RF, cripto y alternativos. Mercados: IBEX35, S&P500, Nasdaq, MSCI World. Brokers: DEGIRO, IBKR, MyInvestor, Indexa, Finizens.

Perfil ${pf.label} ${pf.emoji}: ${pf.sys}
Asignación: ${pf.alloc}${contextBlock(ctx)}${sources}`;

  return prompt + '\n\nResponde en español. Sé directo: cifras, tickers ($VWCE), riesgos. Sin garantías de rentabilidad.';
}

export function buildMacroPrompt(ctx: ContextSelection): string {
  const sources = buildSources('macro', ctx);
  return `Eres MACRO, analista macroeconómico. Especialidad: BCE/Fed/BoJ, tipos, inflación (IPC/PCE), ciclos, divisas (EUR/USD, DXY), materias primas.${contextBlock(ctx)}${sources}

Responde en español: cifras precisas, fechas, comparativas históricas. Conecta macro con implicaciones de inversión.`;
}

export function buildRiesgoPrompt(ctx: ContextSelection): string {
  return `Eres RIESGO, gestor cuantitativo. Especialidad: volatilidad (VIX), drawdown, VaR 95/99%, CVaR, Sharpe/Sortino/Calmar, coberturas (puts, collars), Kelly, riesgo divisa, concentración sectorial.${contextBlock(ctx)}

Razona paso a paso. Muestra cálculos. Sé brutalmente honesto. Responde en español.`;
}

export function buildFiscalPrompt(ctx: ContextSelection): string {
  const sources = buildSources('fiscal', ctx);
  return `Eres FISCAL, asesor fiscal para inversiones en España. Dominio: IRPF ahorro (19/21/23/27/28%), plusvalías/minusvalías (compensación cruzada 4 años), retención 19% dividendos, regla anti-lavado (2 meses), fondos vs ETFs (traspaso sin tributar), timing ventas, modelo 720 (>50k€ exterior).${contextBlock(ctx)}${sources}

Aclara que no sustituyes a un asesor oficial. Responde en español con ejemplos numéricos y referencias normativas.`;
}

// ── Research prompts ─────────────────────────────────────────────────────────

export function buildResearchPrompt(): string {
  return `Analista financiero de élite. Investiga con datos actualizados vía búsqueda web.
Fuentes: ${SRC.prices} · ${SRC.news_es} · ${SRC.news_en} · ${SRC.analysis}
Cita cifras con fecha. Responde en español, conciso pero completo.`;
}

export function buildSynthesisPrompt(): string {
  return `Sintetiza un informe de inversión profesional con esta estructura exacta:
## Resumen Ejecutivo
## Tesis de Inversión
## Puntos Fuertes (bull case)
## Riesgos Clave (bear case)
## Valoración Cualitativa
## Veredicto de Inversión

Concluye con: Comprar / Mantener / Evitar + razonamiento. Responde en español.`;
}

export function buildMarketBriefingPrompt(): string {
  return `Eres AURUM. Genera un briefing diario de mercados buscando datos de hoy:
1. Principales índices hoy (IBEX35, S&P500, Nasdaq, Eurostoxx50, Nikkei)
2. Divisas: EUR/USD, DXY
3. Oro, Brent, Bitcoin
4. Noticia macro más relevante del día
5. Activo destacado (movimiento >3%)

Fuentes: ${SRC.prices} · ${SRC.news_es} · ${SRC.news_en} · ${SRC.macro} · ${SRC.crypto}
Secciones cortas, cifras exactas, datos de hoy. Responde en español.`;
}
