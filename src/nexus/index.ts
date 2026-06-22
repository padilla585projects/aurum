import type { AgentKey, ChatMessage, Position, ResearchTask, RouteResult, UserMemory, UserProfile } from './types';
import { callProvider } from './providers';
import { routeAgent, routeTask, classifyQuery } from './router';
import { trimHistory } from './tokens';
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
// Research tasks always need live data; synthesis needs full token budget.
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
  const useSearch  = task !== 'risks'; // risks uses DeepSeek (no web), rest use GPT-4o Search
  if (onRoute) onRoute(route);
  return callProvider(route, [{ role: 'user', content: query }], system, undefined, maxTokens, useSearch);
}

// ── Daily market briefing ───────────────────────────────────────────────────
export async function nexusMarketBriefing(): Promise<string> {
  const route = routeAgent('macro');
  return callProvider(
    route,
    [{ role: 'user', content: '¿Cómo están los mercados hoy? Dame el briefing completo.' }],
    buildMarketBriefingPrompt(),
    undefined,
    1536,
    true,
  );
}

// ── Portfolio price refresh ─────────────────────────────────────────────────
export async function nexusPrices(tickers: string[]): Promise<{ ticker: string; price: number }[]> {
  const route = routeTask('prices');
  const reply = await callProvider(
    route,
    [{
      role: 'user',
      content: `Busca el precio de cierre actual de estos activos: ${tickers.join(', ')}. Responde SOLO con JSON válido, sin texto ni backticks: [{"ticker":"XX","price":0.00},...]`,
    }],
    'Eres un asistente financiero. Busca precios actuales y responde SOLO con JSON válido.',
    undefined,
    512,
    true,
  );
  try {
    return JSON.parse(reply.replace(/```[a-z]*\n?|```/g, '').trim());
  } catch { return []; }
}
