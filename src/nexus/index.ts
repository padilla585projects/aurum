import type { AgentKey, ChatMessage, Position, ResearchTask, RouteResult, UserMemory, UserProfile } from './types';
import { callProvider } from './providers';
import { routeAgent, routeTask, classifyQuery } from './router';
import { trimHistory, cacheGet, cacheSet } from './tokens';
import { loadMemory, saveMemory, extractFacts } from './memory';
import { selectContext } from './context';
import {
  buildAurumPrompt, buildMacroPrompt, buildRiesgoPrompt,
  buildFiscalPrompt, buildResearchPrompt, buildSynthesisPrompt,
  buildMarketBriefingPrompt,
} from './prompts';

export type { AgentKey, ChatMessage, DisplayMessage, Position, ResearchTask, UserMemory, UserProfile, Provider, RouteResult } from './types';
export { PROVIDER_META, EMPTY_PROFILE } from './types';
export { PROFILES } from './prompts';
export { clearMemory } from './memory';
export { classifyQuery } from './router';
export { nexusInvestmentProposal } from './advisor';
export type { InvestmentProposal, TradeItem } from './advisor';

// Herramientas financieras exclusivas
export {
  stressTest, detectDrift, rebalancePlan, taxLossOpportunities,
  portfolioRiskScore, etfDeepAnalysis,
  formatStressResults, formatDrift, formatTaxLoss,
} from './tools';
export type { StressResult, DriftResult, RebalanceTrade, TaxLossResult, PortfolioRiskScore } from './tools';

// Motor autónomo
export {
  loadAlerts, saveAlerts, markAlertRead, clearAlerts, unreadCount, addAlert,
  loadRecommendations, saveRecommendation, updateRecommendationPerformance,
  loadAutonomousConfig, saveAutonomousConfig,
  runPortfolioMonitor, evaluateAurumPerformance,
  startMonitor, stopMonitor,
} from './autonomous';
export type { AurumAlert, AlertType, AlertSeverity, RecommendationRecord, AutonomousConfig, MonitorResult, PerformanceSummary } from './autonomous';

// Motor de decisión autónoma
export {
  makeDecision, runAutonomousCycle,
  loadAutoConfig, saveAutoConfig,
  loadActionLog,
  startDecisionScheduler, stopDecisionScheduler,
} from './decisions';
export type { Decision, DecisionType, AutonomousTrade, AutoInvestConfig, ActionLogEntry } from './decisions';

// Auto-mejora
export { loadLessons, buildLessonsBlock, runLearningCycle, clearLessons } from './selflearn';
export type { Lesson } from './selflearn';

// Intérprete de comandos + control de PC/navegador
export { detectActionIntent, executeCommand, commandResultToMessage, runBrowserTask, runLocalAgentTask, sendAgentCommand, getAgentStatus } from './commands';
export type { CommandIntent, CommandResult, ComputerTaskResult } from './commands';

// ── Singleton memory state ──────────────────────────────────────────────────
let _memory: UserMemory = { facts: [], interactions: 0, lastUpdated: 0 };
let _loaded = false;

export async function initNexus(): Promise<void> {
  if (_loaded) return;
  _memory = await loadMemory();
  _loaded = true;
}

export function getMemory(): UserMemory { return _memory; }

// ── Main chat call ──────────────────────────────────────────────────────────
export async function nexusChat(
  agentKey:  AgentKey,
  messages:  ChatMessage[],
  profile:   string,
  portfolio: Position[],
  onSearch?: () => void,
  onRoute?:  (r: RouteResult) => void,
  user?:     UserProfile,
): Promise<string> {
  const route = routeAgent(agentKey);
  if (onRoute) onRoute(route);

  const lastMsg = [...messages].reverse().find(m => m.role === 'user');
  const query   = typeof lastMsg?.content === 'string' ? lastMsg.content : '';
  const ctx     = selectContext(query, agentKey, portfolio, user ?? ({} as UserProfile), _memory);

  let system: string;
  switch (agentKey) {
    case 'aurum':  system = buildAurumPrompt(profile, ctx); break;
    case 'macro':  system = buildMacroPrompt(ctx);          break;
    case 'riesgo': system = buildRiesgoPrompt(ctx);         break;
    case 'fiscal': system = buildFiscalPrompt(ctx);         break;
    default:       system = buildAurumPrompt(profile, ctx); break;
  }

  const trimmed = trimHistory(messages);
  const text    = await callProvider(route, trimmed, system, onSearch, ctx.maxTokens, ctx.useWebSearch);

  // Async memory extraction every 5 interactions
  _memory.interactions++;
  if (_memory.interactions % 5 === 0) {
    extractFacts([...messages, { role: 'assistant', content: text }], _memory)
      .then(updated => { _memory = updated; saveMemory(_memory); })
      .catch(() => {});
  } else {
    saveMemory(_memory);
  }

  return text;
}

// ── Research pipeline ───────────────────────────────────────────────────────
const RESEARCH_MAX_TOKENS: Partial<Record<ResearchTask, number>> = {
  news:       1024,
  financials: 1024,
  analysts:   1024,
  macro:      1024,
  risks:      1536,
  synthesis:  2048,
  prices:      512,
};

export async function nexusResearch(
  task:     ResearchTask,
  query:    string,
  onRoute?: (r: RouteResult) => void,
): Promise<string> {
  const route      = routeTask(task);
  const system     = task === 'synthesis' ? buildSynthesisPrompt() : buildResearchPrompt();
  const maxTokens  = RESEARCH_MAX_TOKENS[task] ?? 1024;
  const useSearch  = task !== 'risks';
  if (onRoute) onRoute(route);
  return callProvider(route, [{ role: 'user', content: query }], system, undefined, maxTokens, useSearch);
}

// ── Daily market briefing ───────────────────────────────────────────────────
export async function nexusMarketBriefing(): Promise<string> {
  const key = 'briefing';
  const cached = cacheGet(key);
  if (cached) return cached;

  const route = routeAgent('macro');
  const result = await callProvider(
    route,
    [{ role: 'user', content: '¿Cómo están los mercados hoy? Dame el briefing completo.' }],
    buildMarketBriefingPrompt(),
    undefined, 1536, true,
  );
  cacheSet(key, result);
  return result;
}

// ── Portfolio price refresh ─────────────────────────────────────────────────
// Prioridad: 1) Backend /prices (Yahoo Finance, 0 tokens)  2) IA como fallback

async function _getBackendCfg(): Promise<{ url: string; apiKey: string } | null> {
  try {
    const v = localStorage.getItem('aurum-backend-config');
    if (!v) return null;
    const cfg = JSON.parse(v);
    return cfg?.url && cfg?.apiKey ? cfg : null;
  } catch { return null; }
}

export async function nexusPrices(tickers: string[]): Promise<{ ticker: string; price: number }[]> {
  if (!tickers.length) return [];
  const key    = `prices:${[...tickers].sort().join(',')}`;
  const cached = cacheGet(key);
  if (cached) { try { return JSON.parse(cached); } catch {} }

  // Intento 1: backend /prices con Yahoo Finance (gratis, rápido, 0 tokens)
  try {
    const cfg = await _getBackendCfg();
    if (cfg) {
      const res = await fetch(
        `${cfg.url.replace(/\/$/, '')}/prices?tickers=${tickers.join(',')}`,
        { headers: { 'X-AURUM-KEY': cfg.apiKey }, signal: AbortSignal.timeout(6000) },
      );
      if (res.ok) {
        const data = await res.json() as { prices: { ticker: string; price: number }[] };
        if (data.prices?.length) {
          cacheSet(key, JSON.stringify(data.prices));
          return data.prices;
        }
      }
    }
  } catch { /* continúa con fallback */ }

  // Intento 2: IA (último recurso, consume tokens)
  const route = routeTask('prices');
  const reply = await callProvider(
    route,
    [{
      role: 'user',
      content: `Precios actuales de: ${tickers.join(', ')}. SOLO JSON válido, sin texto ni backticks: [{"ticker":"XX","price":0.00},...]`,
    }],
    'Asistente financiero. Busca precios actuales. SOLO JSON.',
    undefined, 512, true,
  );
  try {
    const parsed = JSON.parse(reply.replace(/```[a-z]*\n?|```/g, '').trim());
    cacheSet(key, JSON.stringify(parsed));
    return parsed;
  } catch { return []; }
}
