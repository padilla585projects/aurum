/**
 * Motor de decisión autónoma de AURUM.
 *
 * AURUM no solo aconseja — DECIDE y EJECUTA.
 * Cuando el modo autónomo está activo, este módulo:
 *   1. Analiza cartera + mercado en tiempo real (web search)
 *   2. Toma una decisión: invest / rebalance / hold
 *   3. Si hay backend TR configurado y autoExecute=true → ejecuta sin confirmación
 *   4. Notifica al usuario lo que hizo (alert en UI + Telegram si hay token)
 */

import type { Position, UserProfile } from './types';
import { callAnthropic } from './providers';
import { PROFILES, buildUserBlock } from './prompts';
import { detectDrift, rebalancePlan } from './tools';
import { saveRecommendation, loadAutonomousConfig } from './autonomous';
import { buildLessonsBlock, runLearningCycle } from './selflearn';
import * as store from '../store/state';

// ── Tipos ──────────────────────────────────────────────────────────────────

export type DecisionType = 'invest' | 'rebalance' | 'hold' | 'wait_for_opportunity';

export interface AutonomousTrade {
  ticker:  string;
  name:    string;
  isin:    string;
  amount:  number;
  reason:  string;
}

export interface Decision {
  type:         DecisionType;
  reasoning:    string;
  marketBrief:  string;
  trades:       AutonomousTrade[];
  totalAmount:  number;
  confidence:   number;   // 0-1
  urgency:      'low' | 'medium' | 'high';
  generatedAt:  number;
}

export interface AutoInvestConfig {
  enabled:          boolean;
  maxAmountPerRun:  number;    // máx euros por ejecución autónoma
  runInterval:      'daily' | 'weekly' | 'monthly';
  requireConfirm:   boolean;   // false = sin confirmación del usuario
  lastRunAt:        number;
  nextRunAt:        number;
}

export interface ActionLogEntry {
  id:          string;
  decisionType: DecisionType;
  reasoning:   string;
  trades:      AutonomousTrade[];
  totalAmount: number;
  executed:    boolean;
  executedAt:  number;
  results:     { ticker: string; status: 'ok' | 'error'; msg?: string }[];
}

const AUTO_CFG_KEY = 'aurum-auto-invest-v1';
const ACTION_LOG_KEY = 'aurum-action-log-v1';

const DEFAULT_CFG: AutoInvestConfig = {
  enabled:         false,
  maxAmountPerRun: 100,
  runInterval:     'weekly',
  requireConfirm:  true,   // por seguridad, empieza con confirmación
  lastRunAt:       0,
  nextRunAt:       0,
};

// ── Config ─────────────────────────────────────────────────────────────────

export function loadAutoConfig(): AutoInvestConfig {
  return { ...DEFAULT_CFG, ...store.get<Partial<AutoInvestConfig>>(AUTO_CFG_KEY, {}) };
}

export function saveAutoConfig(cfg: AutoInvestConfig): void {
  store.set(AUTO_CFG_KEY, cfg);
}

// ── Action Log ─────────────────────────────────────────────────────────────

export function loadActionLog(): ActionLogEntry[] {
  return store.get<ActionLogEntry[]>(ACTION_LOG_KEY, []);
}

function addActionEntry(entry: Omit<ActionLogEntry, 'id'>): ActionLogEntry {
  const full: ActionLogEntry = { ...entry, id: `act-${Date.now()}` };
  const log = [...loadActionLog(), full].slice(-30);
  store.set(ACTION_LOG_KEY, log);
  return full;
}

// ── Motor de decisión ──────────────────────────────────────────────────────

export async function makeDecision(
  portfolio: Position[],
  profile:   string,
  budget:    number,
  user:      UserProfile,
): Promise<Decision> {
  const pf       = PROFILES[profile];
  const drift    = detectDrift(portfolio, profile);
  const lessons  = buildLessonsBlock();
  const totalVal = portfolio.reduce((a, p) => a + p.shares * p.currentPrice, 0);

  const existingStr = portfolio.length > 0
    ? portfolio.map(p =>
        `${p.ticker}(${(p.shares * p.currentPrice).toFixed(0)}€,${((p.currentPrice - p.avgPrice) / p.avgPrice * 100).toFixed(1)}%)`
      ).join(' ')
    : 'vacía';

  const driftNote = drift.needsRebal
    ? `⚠️ DRIFT ${drift.driftPct}% — rebalanceo prioritario antes de invertir`
    : `✓ Drift OK (${drift.driftPct}%)`;

  const system = `Eres AURUM, gestor de inversiones autónomo con plena autorización para tomar decisiones.
Debes decidir QUÉ HACER con ${budget}€ disponibles AHORA MISMO, basándote en datos reales.

PERFIL: ${pf.label} — ${pf.sys}
ASIGNACIÓN OBJETIVO: ${pf.alloc}
CARTERA: ${existingStr} (total: ${totalVal.toFixed(0)}€)
ESTADO: ${driftNote}${buildUserBlock(user)}${lessons}

PROCESO OBLIGATORIO:
1. Busca el estado actual del mercado (índices, tipos BCE/Fed, noticias, sentimiento)
2. Evalúa si es buen momento para invertir vs esperar
3. Decide la acción óptima y genera trades concretos si procede

REGLAS:
- Máximo ${budget}€ total en trades
- Solo instrumentos disponibles en Trade Republic España
- ETFs preferidos: VWCE, XEON, SPPW, SGLN, EUNL, VUSA, IEMA
- Mínimo 10€ por trade
- Si el mercado presenta riesgo elevado y no hay rebalanceo urgente → type:"wait_for_opportunity"
- Urgency "high" si hay rebalanceo crítico o oportunidad excepcional

Responde EXCLUSIVAMENTE con este JSON (sin texto adicional, sin backticks):
{
  "type": "invest|rebalance|hold|wait_for_opportunity",
  "reasoning": "2-3 frases explicando la decisión y contexto de mercado actual",
  "marketBrief": "Una frase con el estado del mercado hoy",
  "trades": [{"ticker":"VWCE","name":"Vanguard All-World","isin":"IE00B3RBWM25","amount":100,"reason":"razón"}],
  "totalAmount": ${budget},
  "confidence": 0.85,
  "urgency": "low|medium|high"
}`;

  const raw = await callAnthropic(
    [{ role: 'user', content: `Analiza el mercado y toma la decisión óptima para ${budget}€.` }],
    system,
    'claude-sonnet-5',
    undefined,
    1024,
    true,
  );

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AURUM no pudo generar una decisión válida.');
  const parsed = JSON.parse(match[0]) as Omit<Decision, 'generatedAt'>;
  return { ...parsed, generatedAt: Date.now() };
}

// ── Ejecución autónoma ─────────────────────────────────────────────────────

interface BackendCfg { url: string; apiKey: string }

async function executeViaBackend(
  cfg:    BackendCfg,
  trades: AutonomousTrade[],
): Promise<{ ticker: string; status: 'ok' | 'error'; msg?: string }[]> {
  const res = await fetch(`${cfg.url.replace(/\/$/, '')}/invest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AURUM-KEY': cfg.apiKey },
    body: JSON.stringify({ trades }),
  });
  if (!res.ok) throw new Error(`Backend ${res.status}`);
  const data = await res.json();
  return (data.results as any[]).map(r => ({
    ticker: r.ticker,
    status: r.status === 'executed' ? 'ok' : 'error',
    msg:    r.status === 'error' ? r.error : r.orderId,
  }));
}

/**
 * Ciclo autónomo completo: decide → (ejecuta si autoExecute) → registra → aprende.
 * Llamado desde autonomous.ts según el intervalo configurado.
 */
export async function runAutonomousCycle(
  portfolio:  Position[],
  profile:    string,
  user:       UserProfile,
  backendCfg: BackendCfg | null,
  onDecision?: (d: Decision, executed: boolean) => void,
): Promise<void> {
  const autoCfg = loadAutoConfig();
  if (!autoCfg.enabled) return;

  // ¿Es momento de correr?
  const now = Date.now();
  const intervalMs = { daily: 86400_000, weekly: 604800_000, monthly: 2592000_000 }[autoCfg.runInterval];
  if (now - autoCfg.lastRunAt < intervalMs) return;

  let decision: Decision;
  try {
    decision = await makeDecision(portfolio, profile, autoCfg.maxAmountPerRun, user);
  } catch (e) {
    console.error('[AURUM autonomous] Decision error:', e);
    return;
  }

  const shouldExecute = (
    !autoCfg.requireConfirm &&           // sin confirmación
    backendCfg !== null &&               // hay backend TR
    decision.type !== 'hold' &&
    decision.type !== 'wait_for_opportunity' &&
    decision.trades.length > 0 &&
    decision.confidence >= 0.7           // solo si AURUM está bastante seguro
  );

  let results: ActionLogEntry['results'] = [];
  let executed = false;

  if (shouldExecute && backendCfg) {
    try {
      results  = await executeViaBackend(backendCfg, decision.trades);
      executed = results.some(r => r.status === 'ok');
    } catch (e) {
      results = decision.trades.map(t => ({ ticker: t.ticker, status: 'error' as const, msg: String(e) }));
    }
  }

  // Registrar en el log
  addActionEntry({
    decisionType: decision.type,
    reasoning:    decision.reasoning,
    trades:       decision.trades,
    totalAmount:  decision.totalAmount,
    executed,
    executedAt:   now,
    results,
  });

  // Guardar recomendación para tracking de rendimiento
  if (decision.trades.length > 0) {
    saveRecommendation({
      trades:   decision.trades.map(t => ({ ticker: t.ticker, amount: t.amount, isin: t.isin })),
      profile,
      capital:  decision.totalAmount,
      rationale: decision.reasoning,
      executed,
    });
  }

  // Actualizar config
  saveAutoConfig({ ...autoCfg, lastRunAt: now, nextRunAt: now + intervalMs });

  // Notificar a la UI
  if (onDecision) onDecision(decision, executed);

  // Disparar ciclo de aprendizaje (async, no bloquea)
  runLearningCycle().catch(() => {});
}

// ── Scheduler ─────────────────────────────────────────────────────────────

let _decisionInterval: ReturnType<typeof setInterval> | null = null;

export function startDecisionScheduler(
  getPortfolio:  () => Position[],
  getProfile:    () => string,
  getUser:       () => UserProfile,
  getBackendCfg: () => BackendCfg | null,
  onDecision?:   (d: Decision, executed: boolean) => void,
): void {
  if (_decisionInterval) return;

  const run = () => {
    const cfg = loadAutoConfig();
    if (!cfg.enabled) return;
    runAutonomousCycle(getPortfolio(), getProfile(), getUser(), getBackendCfg(), onDecision)
      .catch(console.error);
  };

  // Revisar cada hora si es momento de correr el ciclo autónomo
  _decisionInterval = setInterval(run, 3600_000);
  run(); // también al arrancar
}

export function stopDecisionScheduler(): void {
  if (_decisionInterval) { clearInterval(_decisionInterval); _decisionInterval = null; }
}
