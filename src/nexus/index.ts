import type { AgentKey, ChatMessage, Position, ResearchTask, RouteResult, UserMemory } from './types';
import { callProvider } from './providers';
import { routeAgent, routeTask } from './router';
import { trimHistory } from './tokens';
import { loadMemory, saveMemory, extractFacts, buildMemoryBlock } from './memory';
import {
  buildAurumPrompt, buildMacroPrompt, buildRiesgoPrompt,
  buildFiscalPrompt, buildResearchPrompt, buildSynthesisPrompt,
} from './prompts';

export type { AgentKey, ChatMessage, DisplayMessage, Position, ResearchTask, UserMemory, Provider, RouteResult } from './types';
export { PROVIDER_META } from './types';
export { PROFILES } from './prompts';
export { clearMemory } from './memory';

// ── Singleton memory state ─────────────────────────────────────
let _memory: UserMemory = { facts: [], interactions: 0, lastUpdated: 0 };
let _loaded = false;

export async function initNexus(): Promise<void> {
  if (_loaded) return;
  _memory = await loadMemory();
  _loaded = true;
}

export function getMemory(): UserMemory { return _memory; }

// ── Dynamic system prompt builder ──────────────────────────────
export function buildSystemPrompt(
  agentKey: AgentKey,
  profile: string,
  portfolio: Position[],
): string {
  switch (agentKey) {
    case 'aurum':  return buildAurumPrompt(profile, portfolio, _memory);
    case 'macro':  return buildMacroPrompt(_memory);
    case 'riesgo': return buildRiesgoPrompt(portfolio, _memory);
    case 'fiscal': return buildFiscalPrompt(_memory);
  }
}

// ── Main chat call ─────────────────────────────────────────────
export async function nexusChat(
  agentKey: AgentKey,
  messages: ChatMessage[],
  profile: string,
  portfolio: Position[],
  onSearch?: () => void,
  onRoute?: (r: RouteResult) => void,
): Promise<string> {
  const route   = routeAgent(agentKey);
  const system  = buildSystemPrompt(agentKey, profile, portfolio);
  const trimmed = trimHistory(messages);

  if (onRoute) onRoute(route);

  const text = await callProvider(route, trimmed, system, onSearch);

  // Async memory extraction every 5 interactions — never blocks response
  _memory.interactions++;
  if (_memory.interactions % 5 === 0) {
    extractFacts([...messages, { role: 'assistant', content: text }], _memory)
      .then(updated => { _memory = updated; })
      .catch(() => {});
  } else {
    await saveMemory(_memory);
  }

  return text;
}

// ── Research pipeline ──────────────────────────────────────────
export async function nexusResearch(
  task: ResearchTask,
  query: string,
  onRoute?: (r: RouteResult) => void,
): Promise<string> {
  const route  = routeTask(task);
  const system = task === 'synthesis' ? buildSynthesisPrompt() : buildResearchPrompt();
  if (onRoute) onRoute(route);
  return callProvider(route, [{ role: 'user', content: query }], system);
}

// ── Portfolio price refresh ────────────────────────────────────
export async function nexusPrices(
  tickers: string[],
): Promise<{ ticker: string; price: number }[]> {
  const route = routeTask('prices');
  const reply = await callProvider(
    route,
    [{
      role: 'user',
      content: `Busca el precio de cierre actual de estos activos: ${tickers.join(', ')}. Responde SOLO con JSON válido, sin texto ni backticks: [{"ticker":"XX","price":0.00},...]`,
    }],
    'Eres un asistente financiero. Busca precios actuales y responde SOLO con JSON válido, sin texto adicional.',
  );
  try {
    return JSON.parse(reply.replace(/```[a-z]*\n?|```/g, '').trim());
  } catch { return []; }
}
