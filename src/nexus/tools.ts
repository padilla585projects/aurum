/**
 * Herramientas financieras exclusivas de AURUM.
 * Capacidades que ningún otro asesor tiene integradas de fábrica.
 */

import type { Position } from './types';
import { callOpenAI } from './providers';
import { PROFILES } from './prompts';

// ── Tipos ──────────────────────────────────────────────────────────────────

export interface StressScenario {
  name:          string;
  year:          string;
  equityDrop:    number;  // % caída RV
  bondChange:    number;  // % cambio RF
  goldChange:    number;  // % cambio oro
  cryptoDrop:    number;  // % caída cripto
  recovery:      string;  // tiempo de recuperación
}

export interface StressResult {
  scenario:    StressScenario;
  portfolioDropPct: number;
  portfolioDropEur: number;
  worstPosition: { ticker: string; lossPct: number };
  recoveryEst:   string;
}

export interface DriftResult {
  current:    { rv: number; rf: number; alt: number };
  target:     { rv: number; rf: number; alt: number };
  driftPct:   number;
  needsRebal: boolean;
  message:    string;
}

export interface RebalanceTrade {
  ticker:  string;
  action:  'comprar' | 'vender';
  amount:  number;
  reason:  string;
}

export interface TaxLossResult {
  losers:    { ticker: string; loss: number; lossPct: number }[];
  total:     number;
  savings:   number;  // ahorro fiscal estimado (19%)
  advice:    string;
}

export interface PortfolioRiskScore {
  score:      number;    // 0-100
  label:      'Bajo' | 'Moderado' | 'Alto' | 'Muy Alto';
  color:      string;
  breakdown:  { factor: string; value: string; weight: number }[];
}

// ── Escenarios históricos ───────────────────────────────────────────────────

const SCENARIOS: StressScenario[] = [
  {
    name:       'Crisis Financiera 2008',
    year:       '2008',
    equityDrop: -55,
    bondChange: +8,
    goldChange: +5,
    cryptoDrop: 0,
    recovery:   '~4 años (recuperó en 2012)',
  },
  {
    name:       'Burbuja Dot-com 2000-02',
    year:       '2000',
    equityDrop: -49,
    bondChange: +12,
    goldChange: +15,
    cryptoDrop: 0,
    recovery:   '~6 años (para MSCI World)',
  },
  {
    name:       'COVID-19 Crash 2020',
    year:       '2020',
    equityDrop: -34,
    bondChange: +4,
    goldChange: +8,
    cryptoDrop: -50,
    recovery:   '~6 meses (recuperación histórica más rápida)',
  },
  {
    name:       'Crisis de Bonos 2022',
    year:       '2022',
    equityDrop: -20,
    bondChange: -22,
    goldChange: -2,
    cryptoDrop: -77,
    recovery:   '~2-3 años (RV) / 3-5 años (RF largo)',
  },
  {
    name:       'Flash Crash Europa 2011',
    year:       '2011',
    equityDrop: -28,
    bondChange: +5,
    goldChange: +12,
    cryptoDrop: 0,
    recovery:   '~2 años',
  },
];

// ── Clasificador de posiciones ─────────────────────────────────────────────

type AssetClass = 'rv' | 'rf' | 'gold' | 'crypto' | 'alt';

function classifyTicker(ticker: string): AssetClass {
  const t = ticker.toUpperCase();
  // Crypto
  if (/BTC|ETH|CRYPTO|COIN|BTCE|WBTC/.test(t))       return 'crypto';
  // Gold
  if (/SGLN|GLD|IAU|GOLD|XGLD|PHAU/.test(t))         return 'gold';
  // Bonds / RF
  if (/XEON|AGGH|IBGS|VGOV|IBTM|SXRMEX|CORP|BOND|CASH|MONEY|EMIM|AGGU|CSBGE|IBCI|BUND/.test(t)) return 'rf';
  // Default: equity ETF or stock
  return 'rv';
}

// ── 1. Stress Test ─────────────────────────────────────────────────────────

export function stressTest(portfolio: Position[]): StressResult[] {
  if (!portfolio.length) return [];

  return SCENARIOS.map(s => {
    let totalValue  = 0;
    let totalAfter  = 0;
    let worstTicker = '';
    let worstLoss   = 0;

    portfolio.forEach(p => {
      const val   = p.shares * p.currentPrice;
      const cls   = classifyTicker(p.ticker);
      let drop    = 0;
      switch (cls) {
        case 'rv':     drop = s.equityDrop / 100;     break;
        case 'rf':     drop = s.bondChange / 100;     break;
        case 'gold':   drop = s.goldChange / 100;     break;
        case 'crypto': drop = s.cryptoDrop / 100;     break;
        case 'alt':    drop = s.equityDrop * 0.7 / 100; break;
      }
      totalValue += val;
      totalAfter += val * (1 + drop);
      if (drop < worstLoss) { worstLoss = drop; worstTicker = p.ticker; }
    });

    const dropEur = totalAfter - totalValue;
    const dropPct = totalValue > 0 ? (dropEur / totalValue) * 100 : 0;

    return {
      scenario:         s,
      portfolioDropPct: Math.round(dropPct * 10) / 10,
      portfolioDropEur: Math.round(dropEur),
      worstPosition:    { ticker: worstTicker, lossPct: Math.round(worstLoss * 1000) / 10 },
      recoveryEst:      s.recovery,
    };
  });
}

// ── 2. Detector de Drift ───────────────────────────────────────────────────

export function detectDrift(portfolio: Position[], profile: string): DriftResult {
  const pf = PROFILES[profile];
  if (!pf || !portfolio.length) {
    return {
      current:    { rv: 0, rf: 0, alt: 0 },
      target:     { rv: 50, rf: 40, alt: 10 },
      driftPct:   0,
      needsRebal: false,
      message:    'Cartera vacía — no hay nada que rebalancear.',
    };
  }

  // Parse target from alloc string "70% RF · 20% RV · 10% Alt."
  const parseAlloc = (str: string) => {
    const rv  = parseInt(str.match(/(\d+)%\s*RV/i)?.[1]  || '0');
    const rf  = parseInt(str.match(/(\d+)%\s*RF/i)?.[1]  || '0');
    const alt = parseInt(str.match(/(\d+)%\s*Alt/i)?.[1] || '0');
    return { rv, rf, alt };
  };
  const target = parseAlloc(pf.alloc);

  // Compute current allocation
  let totalVal = 0, rvVal = 0, rfVal = 0, altVal = 0;
  portfolio.forEach(p => {
    const val = p.shares * p.currentPrice;
    totalVal += val;
    const cls = classifyTicker(p.ticker);
    if (cls === 'rv')    rvVal  += val;
    else if (cls === 'rf') rfVal += val;
    else                 altVal += val;
  });

  const current = totalVal > 0
    ? { rv: Math.round(rvVal / totalVal * 100), rf: Math.round(rfVal / totalVal * 100), alt: Math.round(altVal / totalVal * 100) }
    : { rv: 0, rf: 0, alt: 0 };

  const driftPct = Math.max(
    Math.abs(current.rv  - target.rv),
    Math.abs(current.rf  - target.rf),
    Math.abs(current.alt - target.alt),
  );

  const needsRebal = driftPct >= 8;
  const message = needsRebal
    ? `⚠️ Drift del ${driftPct}% — rebalanceo recomendado. RV actual: ${current.rv}% (objetivo ${target.rv}%), RF: ${current.rf}% (obj ${target.rf}%).`
    : `✓ Cartera alineada con el perfil ${pf.label}. Drift máximo: ${driftPct}% (umbral: 8%).`;

  return { current, target, driftPct, needsRebal, message };
}

// ── 3. Plan de rebalanceo ──────────────────────────────────────────────────

export function rebalancePlan(
  portfolio: Position[],
  profile:   string,
  budget:    number = 0,   // capital adicional disponible
): RebalanceTrade[] {
  const drift = detectDrift(portfolio, profile);
  if (!drift.needsRebal && budget === 0) return [];

  const totalVal = portfolio.reduce((a, p) => a + p.shares * p.currentPrice, 0) + budget;
  const trades:  RebalanceTrade[] = [];

  // ETFs de referencia por clase
  const RV_ETF  = { ticker: 'VWCE',  isin: 'IE00B3RBWM25', name: 'Vanguard FTSE All-World' };
  const RF_ETF  = { ticker: 'XEON',  isin: 'LU0290358497', name: 'Xtrackers EUR Overnight Rate Swap' };
  const ALT_ETF = { ticker: 'SGLN',  isin: 'IE00B579F325', name: 'iShares Physical Gold' };

  const rvTarget  = totalVal * drift.target.rv  / 100;
  const rfTarget  = totalVal * drift.target.rf  / 100;
  const altTarget = totalVal * drift.target.alt / 100;

  let rvCurrent = portfolio
    .filter(p => classifyTicker(p.ticker) === 'rv')
    .reduce((a, p) => a + p.shares * p.currentPrice, 0);
  let rfCurrent = portfolio
    .filter(p => classifyTicker(p.ticker) === 'rf')
    .reduce((a, p) => a + p.shares * p.currentPrice, 0);
  let altCurrent = portfolio
    .filter(p => ['gold','crypto','alt'].includes(classifyTicker(p.ticker)))
    .reduce((a, p) => a + p.shares * p.currentPrice, 0);

  const rvDiff  = rvTarget  - rvCurrent;
  const rfDiff  = rfTarget  - rfCurrent;
  const altDiff = altTarget - altCurrent;

  if (Math.abs(rvDiff) >= 10) {
    trades.push({
      ticker: RV_ETF.ticker,
      action: rvDiff > 0 ? 'comprar' : 'vender',
      amount: Math.abs(Math.round(rvDiff)),
      reason: `Ajustar RV de ${drift.current.rv}% a ${drift.target.rv}%`,
    });
  }
  if (Math.abs(rfDiff) >= 10) {
    trades.push({
      ticker: RF_ETF.ticker,
      action: rfDiff > 0 ? 'comprar' : 'vender',
      amount: Math.abs(Math.round(rfDiff)),
      reason: `Ajustar RF de ${drift.current.rf}% a ${drift.target.rf}%`,
    });
  }
  if (Math.abs(altDiff) >= 10) {
    trades.push({
      ticker: ALT_ETF.ticker,
      action: altDiff > 0 ? 'comprar' : 'vender',
      amount: Math.abs(Math.round(altDiff)),
      reason: `Ajustar Alt de ${drift.current.alt}% a ${drift.target.alt}%`,
    });
  }

  return trades;
}

// ── 4. Tax-Loss Harvesting ─────────────────────────────────────────────────

export function taxLossOpportunities(portfolio: Position[]): TaxLossResult {
  const TAX_RATE = 0.19; // Base IRPF ahorro

  const losers = portfolio
    .filter(p => p.currentPrice < p.avgPrice)
    .map(p => {
      const loss    = (p.currentPrice - p.avgPrice) * p.shares;
      const lossPct = ((p.currentPrice - p.avgPrice) / p.avgPrice) * 100;
      return { ticker: p.ticker, loss: Math.round(loss), lossPct: Math.round(lossPct * 10) / 10 };
    })
    .sort((a, b) => a.loss - b.loss); // más pérdida primero

  const total   = losers.reduce((a, l) => a + l.loss, 0);
  const savings = Math.abs(total) * TAX_RATE;

  let advice = '';
  if (!losers.length) {
    advice = 'No hay posiciones en pérdidas. Considera si hay ganancias que compensar con pérdidas de años anteriores.';
  } else {
    const topTicker = losers[0].ticker;
    advice =
      `Vender ${topTicker} y equivalentes genera ${Math.abs(Math.round(total))}€ en pérdidas fiscales, ` +
      `ahorrando ~${Math.round(savings)}€ en IRPF (19%). ` +
      `Recuerda la regla de los 2 meses: no vuelvas a comprar el mismo activo (o uno sustancialmente similar) en 2 meses.`;
  }

  return { losers, total: Math.round(total), savings: Math.round(savings), advice };
}

// ── 5. Scoring de riesgo ───────────────────────────────────────────────────

export function portfolioRiskScore(portfolio: Position[]): PortfolioRiskScore {
  if (!portfolio.length) return { score: 0, label: 'Bajo', color: '#2a9d6e', breakdown: [] };

  const total = portfolio.reduce((a, p) => a + p.shares * p.currentPrice, 0);
  if (total === 0) return { score: 0, label: 'Bajo', color: '#2a9d6e', breakdown: [] };

  // Factor 1: Concentración (Herfindahl-Hirschman)
  const hhiRaw = portfolio.reduce((a, p) => {
    const w = (p.shares * p.currentPrice) / total;
    return a + w * w;
  }, 0);
  const hhiScore = Math.min(100, Math.round(hhiRaw * 100)); // 0=diversificado, 100=concentrado

  // Factor 2: % Cripto
  const cryptoPct = portfolio
    .filter(p => classifyTicker(p.ticker) === 'crypto')
    .reduce((a, p) => a + p.shares * p.currentPrice, 0) / total * 100;
  const cryptoScore = Math.min(100, Math.round(cryptoPct * 2));

  // Factor 3: % RV (renta variable)
  const rvPct = portfolio
    .filter(p => classifyTicker(p.ticker) === 'rv')
    .reduce((a, p) => a + p.shares * p.currentPrice, 0) / total * 100;
  const rvScore = Math.min(100, Math.round(rvPct));

  // Factor 4: número de posiciones (menos = más concentrado)
  const posScore = Math.max(0, 100 - portfolio.length * 15);

  // Ponderación
  const score = Math.round(hhiScore * 0.30 + cryptoScore * 0.25 + rvScore * 0.30 + posScore * 0.15);

  const label: PortfolioRiskScore['label'] =
    score < 30 ? 'Bajo' : score < 55 ? 'Moderado' : score < 75 ? 'Alto' : 'Muy Alto';
  const color =
    score < 30 ? '#2a9d6e' : score < 55 ? '#c9a84c' : score < 75 ? '#e8734a' : '#e05252';

  const breakdown = [
    { factor: 'Concentración (HHI)',  value: `${hhiScore}/100`,   weight: 30 },
    { factor: 'Exposición cripto',    value: `${Math.round(cryptoPct)}%`, weight: 25 },
    { factor: 'Renta variable',       value: `${Math.round(rvPct)}%`,    weight: 30 },
    { factor: 'Diversificación',      value: `${portfolio.length} posic.`, weight: 15 },
  ];

  return { score, label, color, breakdown };
}

// ── 6. ETF Deep Analysis (vía web) ────────────────────────────────────────

export async function etfDeepAnalysis(ticker: string): Promise<string> {
  return callOpenAI(
    [{
      role: 'user',
      content:
        `Análisis completo del ETF ${ticker}. Busca en justetf.com y morningstar.es:\n` +
        `1. Índice replicado y método (físico/sintético)\n` +
        `2. TER (total expense ratio)\n` +
        `3. AUM en millones €\n` +
        `4. Tracking error\n` +
        `5. Rentabilidad: YTD, 1a, 3a, 5a (cifras reales)\n` +
        `6. Política dividendos (acumulación/distribución)\n` +
        `7. ISIN y bolsa de cotización principal\n` +
        `8. 2-3 alternativas más baratas o mejores\n` +
        `9. Veredicto: ¿es una buena elección para un inversor español?`,
    }],
    'Analista experto en ETFs europeos. Usa datos reales y actuales. Sé preciso con las cifras.',
    'gpt-4o-search-preview',
    1024,
    true,
  );
}

// ── 7. Formateador de resultados para UI ────────────────────────────────────

export function formatStressResults(results: StressResult[]): string {
  if (!results.length) return 'No hay posiciones para testear.';
  return results.map(r =>
    `**${r.scenario.name}** (${r.scenario.year})\n` +
    `Pérdida estimada: ${r.portfolioDropPct}% (${r.portfolioDropEur.toLocaleString('es-ES')}€) · ` +
    `Peor posición: ${r.worstPosition.ticker} ${r.worstPosition.lossPct}% · ` +
    `Recuperación: ${r.recoveryEst}`
  ).join('\n\n');
}

export function formatDrift(d: DriftResult): string {
  return `${d.message}\n\nActual — RV:${d.current.rv}% RF:${d.current.rf}% Alt:${d.current.alt}%\nObjetivo — RV:${d.target.rv}% RF:${d.target.rf}% Alt:${d.target.alt}%`;
}

export function formatTaxLoss(t: TaxLossResult): string {
  if (!t.losers.length) return t.advice;
  const rows = t.losers.map(l =>
    `**${l.ticker}**: ${l.loss.toLocaleString('es-ES')}€ (${l.lossPct}%)`
  ).join('\n');
  return `**Posiciones en pérdidas:**\n${rows}\n\n**Total pérdidas:** ${Math.abs(t.total).toLocaleString('es-ES')}€\n**Ahorro fiscal estimado (19%):** ${t.savings.toLocaleString('es-ES')}€\n\n${t.advice}`;
}
