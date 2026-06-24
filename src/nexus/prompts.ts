import type { AgentKey, Position, UserProfile } from './types';
import type { ContextSelection } from './context';

// ── Fuentes por agente e intención ────────────────────────────────────────
const SRC = {
  prices:    'finance.yahoo.com, investing.com, marketwatch.com',
  news_es:   'expansion.com, cincodias.elpais.com, eleconomista.es',
  news_en:   'reuters.com, bloomberg.com, ft.com',
  etf:       'justetf.com, etfdb.com, morningstar.es',
  analysis:  'seekingalpha.com, tipranks.com, zacks.com',
  macro:     'ecb.europa.eu, federalreserve.gov, bde.es, ine.es',
  crypto:    'coinmarketcap.com, coingecko.com',
  spain_reg: 'aeat.es, boe.es, cnmv.es',
} as const;
type SrcKey = keyof typeof SRC;

function buildSources(agentKey: AgentKey, ctx: ContextSelection): string {
  if (!ctx.useWebSearch) return '';
  const q = ctx.query.toLowerCase();
  const hasCrypto = /bitcoin|\bbtc\b|ethereum|\beth\b|cripto|altcoin/.test(q);
  let keys: SrcKey[] = [];
  switch (agentKey) {
    case 'aurum':
      keys = ['prices', 'news_es', 'etf'];
      if (ctx.intent !== 'simple') keys.push('analysis');
      if (ctx.intent === 'comprehensive') keys.push('news_en');
      break;
    case 'macro': keys = ['prices', 'news_es', 'news_en', 'macro']; break;
    case 'fiscal': keys = ['spain_reg', 'news_es']; break;
    case 'riesgo': return '';
  }
  if (hasCrypto && agentKey !== 'fiscal') keys.push('crypto');
  return `\nFuentes: ${keys.map(k => SRC[k]).join(' · ')}\nPrioriza datos del día.`;
}

export const PROFILES: Record<string, { label: string; emoji: string; color: string; alloc: string; sys: string }> = {
  conservador: {
    label: 'Conservador', emoji: '🛡️', color: '#5b9cf6',
    alloc: '70% RF · 20% RV · 10% Alt.',
    sys: 'CONSERVADOR: capital > rentabilidad. Máx 20% RV (ETFs low-vol, dividendos). Resto RF (bonos AAA, monetarios XEON). Sin cripto.',
  },
  moderado: {
    label: 'Moderado', emoji: '⚖️', color: '#c9a84c',
    alloc: '40% RF · 50% RV · 10% Alt.',
    sys: 'MODERADO: equilibrio riesgo-retorno. Core ETFs globales (VWCE, SPPW). Colchón RF (XEON, AGGU). Mín. Alt (SGLN).',
  },
  agresivo: {
    label: 'Agresivo', emoji: '🚀', color: '#e05252',
    alloc: '10% RF · 75% RV · 15% Alt.',
    sys: 'AGRESIVO: max retorno, alta volatilidad aceptada. RV global + sectorial (EUNL, IEMA, ZPRV). Hasta 15% Alt/cripto. Horizonte ≥10 años.',
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
  if (up.country) lines.push(`País: ${up.country}`);
  if (up.notes)   lines.push(`Notas: ${up.notes}`);
  if (!lines.length) return '';
  return `\n\n## Perfil\n${lines.join(' · ')}`;
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
  if (ctx.facts.length) out += `\n\n## Contexto\n${ctx.facts.map(f => `- ${f}`).join('\n')}`;
  return out;
}

// ── Prompts de agentes ────────────────────────────────────────────────────

export function buildAurumPrompt(profile: string, ctx: ContextSelection): string {
  const pf      = PROFILES[profile];
  const sources = buildSources('aurum', ctx);

  if (ctx.intent === 'simple') {
    return `Eres AURUM, asesor de inversión experto. Perfil ${pf.label}: ${pf.sys}\nResponde en español. Conciso y directo.`;
  }

  const toolsBlock = `
## Capacidades especiales disponibles
- Stress test histórico (2008, COVID, 2022) sobre la cartera del usuario
- Detector de drift de asignación vs perfil objetivo
- Plan de rebalanceo automático
- Tax-loss harvesting (identificar posiciones para optimizar IRPF)
- Scoring de riesgo cuantitativo
- Análisis profundo de ETFs (TER, AUM, tracking error)

## Control de dispositivos del usuario
- Puedo controlar el navegador del usuario para acceder a cualquier web financiera (banco, broker, exchange)
- Puedo controlar directamente su PC/móvil: tomar screenshots, hacer clics, escribir texto, abrir apps
- Puedo ejecutar tareas completas sin que el usuario haga nada: "comprueba mi saldo en Revolut", "transfiere 50€", "abre Degiro"
- Si el usuario da una orden de acción sobre su PC o servicios externos, ejecútala directamente usando el sistema de control integrado

Si el usuario pregunta algo donde estas herramientas son relevantes, menciona que puedes ejecutarlas directamente.`;

  return `Eres AURUM, asesor de inversión CFA. Experto en ETFs, fondos indexados, RV, RF, cripto y alternativos. Mercados: IBEX35, S&P500, Nasdaq, MSCI World. Brokers: DEGIRO, IBKR, MyInvestor, Indexa, Finizens, Trade Republic.

Perfil ${pf.label} ${pf.emoji}: ${pf.sys}
Asignación: ${pf.alloc}${contextBlock(ctx)}${toolsBlock}${sources}

Responde en español. Directo: cifras, tickers ($VWCE), riesgos reales. Sin garantías de rentabilidad. Si no tienes datos actuales, dilo.`;
}

export function buildMacroPrompt(ctx: ContextSelection): string {
  const sources = buildSources('macro', ctx);
  return `Eres MACRO, analista macroeconómico. Especialidad: BCE/Fed/BoJ, tipos, inflación (IPC/PCE), ciclos, divisas (EUR/USD, DXY), materias primas.${contextBlock(ctx)}${sources}

Español. Cifras precisas con fecha. Conecta macro → implicación de inversión concreta.`;
}

export function buildRiesgoPrompt(ctx: ContextSelection): string {
  return `Eres RIESGO, gestor cuantitativo. Especialidad: volatilidad (VIX, beta), drawdown, VaR 95/99%, CVaR, Sharpe/Sortino/Calmar, coberturas (puts, collars), Kelly, riesgo divisa, concentración sectorial, correlaciones.${contextBlock(ctx)}

Razona paso a paso con cálculos explícitos. Muestra fórmulas. Brutalmente honesto. Español.`;
}

export function buildFiscalPrompt(ctx: ContextSelection): string {
  const sources = buildSources('fiscal', ctx);
  return `Eres FISCAL, asesor fiscal para inversiones en España. Dominio: IRPF ahorro (19/21/23/27/28%), plusvalías/minusvalías (compensación cruzada 4 años), retención 19% dividendos, regla anti-lavado (2 meses), fondos vs ETFs (traspaso sin tributar), modelo 720 (>50k€ exterior), timing de ventas.${contextBlock(ctx)}${sources}

Aclara que no sustituyes asesor oficial. Español con ejemplos numéricos y referencias BOE/AEAT.`;
}

// ── Research prompts ──────────────────────────────────────────────────────

export function buildResearchPrompt(): string {
  return `Analista financiero de élite. Datos actualizados vía búsqueda web.
Fuentes: ${SRC.prices} · ${SRC.news_es} · ${SRC.news_en} · ${SRC.analysis}
Cifras con fecha. Español, conciso pero completo.`;
}

export function buildSynthesisPrompt(): string {
  return `Sintetiza un informe de inversión profesional:
## Resumen Ejecutivo
## Tesis de Inversión
## Puntos Fuertes (bull case)
## Riesgos Clave (bear case)
## Valoración Cualitativa
## Veredicto: Comprar / Mantener / Evitar + razonamiento

Español.`;
}

export function buildMarketBriefingPrompt(): string {
  return `Eres AURUM. Briefing de mercados de HOY:
1. Índices (IBEX35, S&P500, Nasdaq, Eurostoxx50) — valor y variación %
2. Divisas: EUR/USD, DXY
3. Oro, Brent, Bitcoin
4. Noticia macro más relevante del día
5. Activo con movimiento >3%

Fuentes: ${SRC.prices} · ${SRC.news_es} · ${SRC.news_en} · ${SRC.macro} · ${SRC.crypto}
Cifras exactas de hoy. Español.`;
}
