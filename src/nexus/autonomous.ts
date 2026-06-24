/**
 * Motor de monitorización autónoma de AURUM.
 *
 * - Genera alertas en tiempo real: drift, riesgo, pérdidas
 * - Registra y trackea recomendaciones de inversión
 * - Evalúa el rendimiento histórico de los consejos de AURUM
 * - Corre un timer en background que comprueba la cartera periódicamente
 */

import type { Position } from './types';
import { detectDrift, portfolioRiskScore } from './tools';

// ── Storage keys ──────────────────────────────────────────────────────────────
const ALERTS_KEY     = 'aurum-alerts-v2';
const RECS_KEY       = 'aurum-recommendations-v2';
const MON_CFG_KEY    = 'aurum-monitor-config-v2';
const MAX_ALERTS     = 50;
const MAX_RECS       = 100;

// ── Types ─────────────────────────────────────────────────────────────────────

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertType =
  | 'drift'
  | 'risk'
  | 'loss'
  | 'recommendation_update'
  | 'price_move'
  | 'system';

export interface AurumAlert {
  id:          string;
  type:        AlertType;
  severity:    AlertSeverity;
  title:       string;
  body:        string;
  read:        boolean;
  createdAt:   number;
  actionable?: boolean;
  action?:     string;
  actionTab?:  string;
}

export interface RecommendationRecord {
  id:               string;
  createdAt:        number;
  trades:           { ticker: string; amount: number; isin: string }[];
  profile:          string;
  capital:          number;
  rationale:        string;
  executed:         boolean;
  estimatedReturn?: number;   // % estimado por AURUM
  actualReturn?:    number;   // % real (registrado posteriormente)
}

export interface AutonomousConfig {
  enabled:         boolean;
  alertOnDrift:    boolean;
  alertOnRisk:     boolean;
  alertOnLoss:     boolean;
  monitorInterval: number;   // minutos
  lossThreshold:   number;   // % negativo, ej: -10
}

export interface MonitorResult {
  newAlerts:  AurumAlert[];
  driftScore: number;        // 0-100: desviación de asignación objetivo
  riskScore:  number;        // 0-10: puntuación de riesgo
  timestamp:  number;
}

export interface PerformanceSummary {
  totalRecs:      number;
  executedRecs:   number;
  accuracy:       number;    // % de recomendaciones con retorno real positivo
  withActualData: number;    // recomendaciones con retorno real registrado
  avgEstimated:   number;    // % retorno medio estimado
  avgActual:      number;    // % retorno medio real
  verdict:        string;
}

// ── Alert storage ─────────────────────────────────────────────────────────────

export function loadAlerts(): AurumAlert[] {
  try {
    const v = localStorage.getItem(ALERTS_KEY);
    return v ? JSON.parse(v) : [];
  } catch { return []; }
}

export function saveAlerts(alerts: AurumAlert[]): void {
  try { localStorage.setItem(ALERTS_KEY, JSON.stringify(alerts.slice(0, MAX_ALERTS))); } catch {}
}

export function addAlert(
  alert: Omit<AurumAlert, 'id' | 'createdAt' | 'read'>,
): void {
  const alerts = loadAlerts();
  const newAlert: AurumAlert = {
    ...alert,
    id:        `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
    read:      false,
  };
  saveAlerts([newAlert, ...alerts]);
}

export function markAlertRead(id: string): void {
  const alerts = loadAlerts().map(a => a.id === id ? { ...a, read: true } : a);
  saveAlerts(alerts);
}

export function clearAlerts(): void {
  try { localStorage.removeItem(ALERTS_KEY); } catch {}
}

export function unreadCount(): number {
  return loadAlerts().filter(a => !a.read).length;
}

// ── Recommendation tracking ───────────────────────────────────────────────────

export function loadRecommendations(): RecommendationRecord[] {
  try {
    const v = localStorage.getItem(RECS_KEY);
    return v ? JSON.parse(v) : [];
  } catch { return []; }
}

function saveRecommendations(recs: RecommendationRecord[]): void {
  try { localStorage.setItem(RECS_KEY, JSON.stringify(recs.slice(0, MAX_RECS))); } catch {}
}

export function saveRecommendation(
  rec: Omit<RecommendationRecord, 'id' | 'createdAt'>,
): void {
  const recs = loadRecommendations();
  const full: RecommendationRecord = {
    ...rec,
    id:        `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
  };
  saveRecommendations([full, ...recs]);
}

export function updateRecommendationPerformance(id: string, actualReturn: number): void {
  const recs = loadRecommendations().map(r =>
    r.id === id ? { ...r, actualReturn } : r,
  );
  saveRecommendations(recs);
}

// ── Monitor config ────────────────────────────────────────────────────────────

const DEFAULT_MON_CFG: AutonomousConfig = {
  enabled:         true,
  alertOnDrift:    true,
  alertOnRisk:     true,
  alertOnLoss:     true,
  monitorInterval: 60,
  lossThreshold:   -10,
};

export function loadAutonomousConfig(): AutonomousConfig {
  try {
    const v = localStorage.getItem(MON_CFG_KEY);
    return v ? { ...DEFAULT_MON_CFG, ...JSON.parse(v) } : DEFAULT_MON_CFG;
  } catch { return DEFAULT_MON_CFG; }
}

export function saveAutonomousConfig(cfg: AutonomousConfig): void {
  try { localStorage.setItem(MON_CFG_KEY, JSON.stringify(cfg)); } catch {}
}

// ── Portfolio monitoring ──────────────────────────────────────────────────────

// Asignaciones objetivo por perfil (RF/RV/Alt)
const TARGET_ALLOC: Record<string, { eq: number; fi: number; alt: number }> = {
  conservador: { eq: 0.20, fi: 0.70, alt: 0.10 },
  moderado:    { eq: 0.50, fi: 0.40, alt: 0.10 },
  agresivo:    { eq: 0.75, fi: 0.10, alt: 0.15 },
};

// ETFs de renta fija conocidos
const FI_TICKERS = new Set(['XEON', 'AGGU', 'IS3N', 'IGLT', 'VGOV', 'IBTS', 'SXRM']);
// ETFs alternativos conocidos
const ALT_TICKERS = new Set(['SGLN', 'WGLD', 'BTCE', 'IBIT', 'GBTC', 'IAUM']);

function guessAllocation(portfolio: Position[]): { eq: number; fi: number; alt: number } {
  const total = portfolio.reduce((a, p) => a + p.shares * p.currentPrice, 0);
  if (!total) return { eq: 0, fi: 0, alt: 0 };
  let fi = 0, alt = 0;
  for (const p of portfolio) {
    const val = p.shares * p.currentPrice;
    if (FI_TICKERS.has(p.ticker)) fi += val;
    else if (ALT_TICKERS.has(p.ticker)) alt += val;
  }
  return {
    eq:  (total - fi - alt) / total,
    fi:  fi / total,
    alt: alt / total,
  };
}

export function runPortfolioMonitor(
  portfolio: Position[],
  profile:   string,
): MonitorResult {
  const cfg       = loadAutonomousConfig();
  const newAlerts: AurumAlert[] = [];
  let driftScore  = 0;
  let riskScore   = 0;
  const ts        = Date.now();

  if (!portfolio.length) {
    return { newAlerts, driftScore, riskScore, timestamp: ts };
  }

  // ── 1. Risk score ────────────────────────────────────────────────────────
  if (cfg.alertOnRisk) {
    try {
      const rs = portfolioRiskScore(portfolio);
      // score es 0-100; mapeamos a 0-10 para la lógica de alertas
      riskScore = rs.score / 10;
      if (rs.score >= 80) {
        newAlerts.push({
          id: `${ts}-risk`, type: 'risk', severity: 'critical',
          title: `⚠️ Riesgo muy elevado: ${rs.label} (${rs.score}/100)`,
          body:  `Volatilidad alta, concentración sectorial o drawdown excesivo detectados. Revisa tu cartera.`,
          read: false, createdAt: ts, actionable: true, action: 'Ver análisis', actionTab: 'chat',
        });
      } else if (rs.score >= 65) {
        newAlerts.push({
          id: `${ts}-risk`, type: 'risk', severity: 'warning',
          title: `Riesgo elevado: ${rs.label} (${rs.score}/100)`,
          body:  `Tu cartera tiene exposición significativa. Considera diversificar o añadir renta fija.`,
          read: false, createdAt: ts, actionable: true, action: 'Ver análisis', actionTab: 'chat',
        });
      }
    } catch { /* tools puede fallar si no hay suficientes datos */ }
  }

  // ── 2. Drift de asignación ───────────────────────────────────────────────
  if (cfg.alertOnDrift) {
    try {
      const target = TARGET_ALLOC[profile] ?? TARGET_ALLOC['moderado'];
      const actual = guessAllocation(portfolio);
      const drift  = Math.abs(actual.eq - target.eq) + Math.abs(actual.fi - target.fi) + Math.abs(actual.alt - target.alt);
      driftScore   = Math.min(100, Math.round(drift * 100));
      if (driftScore > 20) {
        const sev: AlertSeverity = driftScore > 35 ? 'critical' : 'warning';
        newAlerts.push({
          id: `${ts}-drift`, type: 'drift', severity: sev,
          title: `Desvío de asignación: ${driftScore}% fuera de objetivo`,
          body:  `Tu cartera se ha alejado del perfil ${profile}. Objetivo: RV ${Math.round(target.eq*100)}% · RF ${Math.round(target.fi*100)}% · Alt ${Math.round(target.alt*100)}%.`,
          read: false, createdAt: ts, actionable: true, action: 'Ver rebalanceo', actionTab: 'invest',
        });
      }
    } catch { /* silencioso */ }
  }

  // ── 3. Posiciones con pérdida significativa ──────────────────────────────
  if (cfg.alertOnLoss) {
    for (const p of portfolio) {
      if (!p.avgPrice || !p.currentPrice) continue;
      const pnlPct = (p.currentPrice - p.avgPrice) / p.avgPrice * 100;
      if (pnlPct <= cfg.lossThreshold) {
        newAlerts.push({
          id: `${ts}-loss-${p.ticker}`, type: 'loss', severity: 'warning',
          title: `📉 ${p.ticker} con pérdida de ${pnlPct.toFixed(1)}%`,
          body:  `Precio medio de compra: ${p.avgPrice.toFixed(2)}€ → actual: ${p.currentPrice.toFixed(2)}€. Considera revisar tu tesis de inversión.`,
          read: false, createdAt: ts, actionable: true, action: 'Analizar con AURUM', actionTab: 'chat',
        });
      }
    }
  }

  // Guardar las alertas nuevas
  if (newAlerts.length) {
    const existing = loadAlerts();
    // Evitar duplicados del mismo tipo generados en las últimas 6 horas
    const SIX_H = 6 * 3600_000;
    const recent = new Set(existing.filter(a => ts - a.createdAt < SIX_H).map(a => a.type));
    const fresh  = newAlerts.filter(a => !recent.has(a.type));
    if (fresh.length) saveAlerts([...fresh, ...existing]);
  }

  return { newAlerts, driftScore, riskScore, timestamp: ts };
}

// ── Performance evaluation ────────────────────────────────────────────────────

export function evaluateAurumPerformance(): PerformanceSummary {
  const recs = loadRecommendations();
  if (!recs.length) {
    return { totalRecs: 0, executedRecs: 0, accuracy: 0, withActualData: 0, avgEstimated: 0, avgActual: 0, verdict: 'Sin historial todavía.' };
  }

  const executed      = recs.filter(r => r.executed);
  const withActual    = recs.filter(r => r.actualReturn !== undefined && r.executed);
  const positiveActual = withActual.filter(r => (r.actualReturn ?? 0) > 0);

  const avgEstimated = withActual.length
    ? +(withActual.reduce((a, r) => a + (r.estimatedReturn ?? 0), 0) / withActual.length).toFixed(1)
    : 0;
  const avgActual = withActual.length
    ? +(withActual.reduce((a, r) => a + (r.actualReturn ?? 0), 0) / withActual.length).toFixed(1)
    : 0;
  const accuracy = withActual.length
    ? Math.round(positiveActual.length / withActual.length * 100)
    : 0;

  let verdict = 'Sin suficientes datos para evaluar.';
  if (withActual.length >= 3) {
    if (accuracy >= 70) verdict = `AURUM tiene un ${accuracy}% de precisión — sólido rendimiento.`;
    else if (accuracy >= 50) verdict = `AURUM acierta en el ${accuracy}% de los casos — rendimiento moderado.`;
    else verdict = `AURUM está aprendiendo: ${accuracy}% de precisión. Mejorará con más datos.`;
    if (avgActual > avgEstimated) verdict += ` Sus estimaciones son conservadoras — la realidad superó las previsiones.`;
  }

  return {
    totalRecs:    recs.length,
    executedRecs: executed.length,
    accuracy,
    withActualData: withActual.length,
    avgEstimated,
    avgActual,
    verdict,
  };
}

// ── Background monitor (timer) ────────────────────────────────────────────────

let _monitorTimer: ReturnType<typeof setInterval> | null = null;
let _lastMonitorRun = 0;

export function startMonitor(
  getPortfolio: () => Position[],
  getProfile:   () => string,
  onUpdate:     (unread: number) => void,
): void {
  if (_monitorTimer) stopMonitor();

  const run = () => {
    const cfg = loadAutonomousConfig();
    if (!cfg.enabled) return;

    const now       = Date.now();
    const intervalMs = Math.max(cfg.monitorInterval, 15) * 60_000;
    if (now - _lastMonitorRun < intervalMs) return;
    _lastMonitorRun = now;

    const portfolio = getPortfolio();
    const profile   = getProfile();
    if (!portfolio.length) return;

    try {
      runPortfolioMonitor(portfolio, profile);
      onUpdate(unreadCount());
    } catch { /* silencioso */ }
  };

  // Primera comprobación al arrancar (delay 5 s para no bloquear el render)
  setTimeout(() => { run(); onUpdate(unreadCount()); }, 5_000);

  // Timer recurrente cada 60 s (la lógica de intervalo real la controla `run()`)
  _monitorTimer = setInterval(() => {
    run();
    onUpdate(unreadCount());
  }, 60_000);
}

export function stopMonitor(): void {
  if (_monitorTimer) {
    clearInterval(_monitorTimer);
    _monitorTimer = null;
  }
}
