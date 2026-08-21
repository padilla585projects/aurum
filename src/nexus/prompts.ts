import type { AgentKey, Position, UserProfile } from './types';
import type { ContextSelection } from './context';
import { bloquePlanes } from './planes';

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

// ── Perfiles de inversión ─────────────────────────────────────────────────
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

/**
 * Revisión de cartera: comprobar si el usuario está haciendo lo que dijo.
 *
 * No es un generador de ideas: es un auditor. Los números se los damos hechos
 * —desviación, riesgo, pérdidas compensables— para que no invente ninguno, y
 * lo que tiene que juzgar es si la cartera se parece a los planes escritos por
 * el usuario, que es lo que ninguna plantilla de perfil sabe.
 */
export const REVISION_SYSTEM = `Eres el auditor de cartera de AURUM. Tu trabajo NO es proponer ideas nuevas: es comprobar si lo que esta persona tiene se parece a lo que dijo que quería hacer.

Te damos los números ya calculados. Úsalos tal cual. No inventes cifras, precios ni rentabilidades: si un dato no está, dilo.

Responde en español, breve y concreto, con esta estructura:

**Veredicto** — una frase: ¿va encaminado o no?

**Lo que está bien** — máximo 3 puntos. Sé específico, cita posiciones.

**Lo que no cuadra con tus planes** — máximo 3 puntos. Aquí está el valor: contrasta la cartera real contra lo que la persona escribió que quiere. Si dijo que necesita liquidez en 3 años y está todo en renta variable, dilo con todas las letras.

**Qué haría ahora** — 1 o 2 acciones concretas, con importes si los hay.

Reglas:
- Si no hay planes escritos, dilo y pide que los escriba: sin ellos solo puedes comparar contra una plantilla genérica, que vale mucho menos.
- Si te damos contexto de mercado, son cuentas sobre los cierres de los ultimos meses: puedes decir donde esta el mercado respecto a donde ha estado, y que implica para esta persona en concreto. Lo que NO puedes es decir hacia donde va. Nadie lo sabe, y sonar seguro sobre eso hace mas daño que callarse.
- Nunca digas «es buen momento para comprar» ni «espera a que baje». Si el usuario aporta periodicamente, el momento importa mucho menos de lo que parece; dilo.
- Si algo va bien, dilo. Un auditor que solo encuentra problemas no sirve.`;

// ── Helpers de contexto ──────────────────────────────────────────────────────

export function buildUserBlock(up: UserProfile): string {
  const lines: string[] = [];
  if (up.name)    lines.push(`Usuario: ${up.name}`);
  if (up.age)     lines.push(`Edad: ${up.age}a`);
  if (up.capital) lines.push(`Capital: ${up.capital}€`);
  if (up.income)  lines.push(`Ingresos: ${up.income}€/año`);
  if (up.horizon) lines.push(`Horizonte: ${up.horizon}`);
  if (up.broker)  lines.push(`Broker: ${up.broker}`);
  if (up.country) lines.push(`País: ${up.country}`);

  // Los planes van en su propio apartado y no como coletilla de la linea de
  // datos. Es lo unico del perfil que el usuario escribe con sus palabras, y
  // aplastado entre la edad y el pais se leia como un dato mas, en vez de
  // como lo que condiciona todo lo demas.
  const planes = up.notes?.trim();
  if (!lines.length && !planes) return '';

  const partes: string[] = [];
  if (lines.length) partes.push('## Perfil', lines.join(' · '));
  if (planes) {
    partes.push(
      '## Planes y situación del usuario',
      planes,
      'Tenlos en cuenta en cada recomendación: mandan sobre cualquier regla general.',
    );
  }
  return ['', '', ...partes].join(String.fromCharCode(10, 10));
}

function portfolioBlock(portfolio: Position[]): string {
  const total = portfolio.reduce((a, p) => a + p.shares * p.currentPrice, 0);
  const rows  = portfolio.map(p => {
    const pnl = ((p.currentPrice - p.avgPrice) / p.avgPrice * 100).toFixed(1);
    return `${p.ticker}(${p.shares}@${p.avgPrice}→${p.currentPrice}€,${+pnl >= 0 ? '+' : ''}${pnl}%)`;
  }).join(' ');
  return `## Cartera\n${rows}\nTotal: ${total.toFixed(0)}€`;
}

function contextBlock(ctx: ContextSelection): string {
  const parts: string[] = [];
  if (ctx.portfolio) parts.push(portfolioBlock(ctx.portfolio));
  if (ctx.planes?.length) parts.push(bloquePlanes(ctx.planes));
  if (ctx.efectivo > 0) {
    // Sin esto, cualquier recomendacion sobre "donde meter dinero" se hace a
    // ciegas: no se sabe si hay algo que mover o no.
    parts.push(`## Efectivo disponible\n${Math.round(ctx.efectivo)}€ sin invertir, en cuenta o deposito.`);
  }
  if (ctx.user)      parts.push(`## Perfil${buildUserBlock(ctx.user).replace(/\n\n## Perfil\n/, '')}`);
  if (ctx.facts.length) parts.push(`## Contexto previo\n${ctx.facts.map(f => `- ${f}`).join('\n')}`);
  return parts.join('\n\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// SISTEMA PROMPT ESTÁTICO (solo rol + capacidades) → 100% cacheado por Anthropic
// El portfolio y datos de usuario van en contextPrefix (primer mensaje user)
// → sistema siempre idéntico para el mismo agente → caché hits máximos
// ══════════════════════════════════════════════════════════════════════════════

const AURUM_TOOLS_BLOCK = `
## Herramientas disponibles
- Stress test histórico (2008, COVID, 2022) sobre la cartera del usuario
- Detector de drift de asignación vs perfil objetivo
- Plan de rebalanceo automático
- Tax-loss harvesting (optimización IRPF)
- Scoring de riesgo cuantitativo
- Análisis profundo de ETFs (TER, AUM, tracking error)
- Control del navegador y PC del usuario (screenshots, clics, apps)

Si el usuario da una orden de acción sobre su PC/servicios externos, ejecútala directamente.`;

/**
 * System prompt 100% estático para AURUM — SIEMPRE igual para el mismo perfil.
 * Usar con callAnthropic(messages, buildAurumSystem(profile), ..., contextPrefix).
 */
export function buildAurumSystem(profile: string): string {
  const pf = PROFILES[profile] ?? PROFILES['moderado'];
  return `Eres AURUM, asesor de inversión CFA. Experto en ETFs, fondos indexados, RV, RF, cripto y alternativos. Mercados: IBEX35, S&P500, Nasdaq, MSCI World. Brokers: DEGIRO, IBKR, MyInvestor, Indexa, Finizens, Trade Republic.

Perfil del inversor: ${pf.label} ${pf.emoji}
${pf.sys}
Asignación objetivo: ${pf.alloc}${AURUM_TOOLS_BLOCK}

Responde en español. Directo: cifras, tickers ($VWCE), riesgos reales. Sin garantías de rentabilidad. Si no tienes datos actuales, dilo.`;
}

/**
 * Contexto dinámico (portfolio, usuario, facts) → se inyecta como prefix del mensaje user,
 * NO en el system prompt. Así el system se mantiene estático y la caché siempre hits.
 */
export function buildContextPrefix(ctx: ContextSelection): string {
  const block = contextBlock(ctx);
  if (!block.trim()) return '';
  return `[Contexto de tu cartera y perfil]\n${block}`;
}

// Variante simple para chat: combina ambos (compatibilidad con código existente)
export function buildAurumPrompt(profile: string, ctx: ContextSelection): string {
  const pf      = PROFILES[profile] ?? PROFILES['moderado'];
  const sources = buildSources('aurum', ctx);

  if (ctx.intent === 'simple') {
    return `Eres AURUM, asesor de inversión experto. Perfil ${pf.label}: ${pf.sys}\nResponde en español. Conciso y directo.`;
  }

  return `Eres AURUM, asesor de inversión CFA. Experto en ETFs, fondos indexados, RV, RF, cripto y alternativos. Mercados: IBEX35, S&P500, Nasdaq, MSCI World. Brokers: DEGIRO, IBKR, MyInvestor, Indexa, Finizens, Trade Republic.

Perfil ${pf.label} ${pf.emoji}: ${pf.sys}
Asignación: ${pf.alloc}${AURUM_TOOLS_BLOCK}${sources}

Responde en español. Directo: cifras, tickers ($VWCE), riesgos reales. Sin garantías de rentabilidad. Si no tienes datos actuales, dilo.`;
}

// ── Prompts estáticos de otros agentes ────────────────────────────────────────

const MACRO_SYSTEM = `Eres MACRO, analista macroeconómico. Especialidad: BCE/Fed/BoJ, tipos, inflación (IPC/PCE), ciclos, divisas (EUR/USD, DXY), materias primas.
Fuentes: ${SRC.prices} · ${SRC.news_es} · ${SRC.news_en} · ${SRC.macro}
Español. Cifras precisas con fecha. Conecta macro → implicación de inversión concreta.`;

const RIESGO_SYSTEM = `Eres RIESGO, gestor cuantitativo. Especialidad: volatilidad (VIX, beta), drawdown, VaR 95/99%, CVaR, Sharpe/Sortino/Calmar, coberturas (puts, collars), Kelly, riesgo divisa, concentración sectorial, correlaciones.
Razona paso a paso con cálculos explícitos. Muestra fórmulas. Brutalmente honesto. Español.`;

const FISCAL_SYSTEM = `Eres FISCAL, asesor fiscal para inversiones en España. Dominio: IRPF ahorro (19/21/23/27/28%), plusvalías/minusvalías (compensación cruzada 4 años), retención 19% dividendos, regla anti-lavado (2 meses), fondos vs ETFs (traspaso sin tributar), modelo 720 (>50k€ exterior), timing de ventas.
Fuentes: ${SRC.spain_reg} · ${SRC.news_es}
Aclara que no sustituyes asesor oficial. Español con ejemplos numéricos y referencias BOE/AEAT.`;

export function buildMacroSystem():  string { return MACRO_SYSTEM; }
export function buildRiesgoSystem(): string { return RIESGO_SYSTEM; }
export function buildFiscalSystem(): string { return FISCAL_SYSTEM; }

// Wrappers con ctx (compatibilidad)
export function buildMacroPrompt(_ctx: ContextSelection):  string { return MACRO_SYSTEM; }
export function buildRiesgoPrompt(_ctx: ContextSelection): string { return RIESGO_SYSTEM; }
export function buildFiscalPrompt(_ctx: ContextSelection): string { return FISCAL_SYSTEM; }

// ── Research prompts (estáticos) ────────────────────────────────────────────

const RESEARCH_SYSTEM = `Analista financiero de élite. Datos actualizados vía búsqueda web.
Fuentes: ${SRC.prices} · ${SRC.news_es} · ${SRC.news_en} · ${SRC.analysis}
Cifras con fecha. Español, conciso pero completo.`;

const SYNTHESIS_SYSTEM = `Sintetiza un informe de inversión profesional con estas secciones:
## Resumen Ejecutivo
## Tesis de Inversión
## Puntos Fuertes (bull case)
## Riesgos Clave (bear case)
## Valoración Cualitativa
## Veredicto: Comprar / Mantener / Evitar + razonamiento

Español.`;

const BRIEFING_SYSTEM = `Eres AURUM. Briefing de mercados de HOY:
1. Índices (IBEX35, S&P500, Nasdaq, Eurostoxx50) — valor y variación %
2. Divisas: EUR/USD, DXY
3. Oro, Brent, Bitcoin
4. Noticia macro más relevante del día
5. Activo con movimiento >3%

Fuentes: ${SRC.prices} · ${SRC.news_es} · ${SRC.news_en} · ${SRC.macro} · ${SRC.crypto}
Cifras exactas de hoy. Español.`;

export function buildResearchPrompt():       string { return RESEARCH_SYSTEM; }
export function buildSynthesisPrompt():      string { return SYNTHESIS_SYSTEM; }
export function buildMarketBriefingPrompt(): string { return BRIEFING_SYSTEM; }
