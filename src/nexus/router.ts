import type { AgentKey, ResearchTask, RouteResult } from './types';

// Each agent is routed to the model best suited for its task:
// - AURUM (general)  → Claude: best conversational quality + web search
// - MACRO            → GPT-4o-search: live market data + structured analysis
// - RIESGO           → DeepSeek-R1: deep math reasoning (VaR, Sharpe, Kelly)
// - FISCAL           → Claude: nuanced Spanish tax law interpretation
const AGENT_ROUTES: Record<AgentKey, RouteResult> = {
  aurum:  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  macro:  { provider: 'openai',    model: 'gpt-4o-search-preview'   },
  riesgo: { provider: 'deepseek',  model: 'deepseek-reasoner'        },
  fiscal: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
};

// Research pipeline: web-search steps via OpenAI, risk reasoning via DeepSeek, synthesis via Claude
const TASK_ROUTES: Record<ResearchTask, RouteResult> = {
  news:       { provider: 'openai',    model: 'gpt-4o-search-preview'   },
  financials: { provider: 'openai',    model: 'gpt-4o-search-preview'   },
  analysts:   { provider: 'openai',    model: 'gpt-4o-search-preview'   },
  macro:      { provider: 'openai',    model: 'gpt-4o-search-preview'   },
  risks:      { provider: 'deepseek',  model: 'deepseek-chat'            },
  synthesis:  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  prices:     { provider: 'openai',    model: 'gpt-4o-search-preview'   },
};

export const routeAgent = (key: AgentKey): RouteResult => AGENT_ROUTES[key];
export const routeTask  = (task: ResearchTask): RouteResult => TASK_ROUTES[task];

// Auto-classify a user query to the most appropriate agent
export function classifyQuery(query: string): AgentKey {
  const q = query.toLowerCase();

  // FISCAL: Spanish tax/fiscal keywords (highest priority — very specific domain)
  if (/irpf|fiscal|impuesto|plusval|hacienda|declara|retenci|aeat|tribut|regla.*(2|dos) meses|(2|dos) meses.*regla|deduc|exenci|patrimonio|societari|autónom|base imponible|ganancia patrimonial/.test(q)) return 'fiscal';

  // RIESGO: quantitative/math risk keywords
  if (/\bvar\b|sharpe|sortino|\bbeta\b|volatil|drawdown|kelly|correlaci|covarianza|desviaci[oó]n|riesgo.*(cartera|portf)|optimiz.*cartera|backt|máxima.pérdida|pérdida.máxima|ratio.*riesgo|rendimiento.ajustado/.test(q)) return 'riesgo';

  // MACRO: crypto + live market / economy / news keywords
  if (/bitcoin|\bbtc\b|ethereum|\beth\b|\bbnb\b|\bsol\b|cripto|crypto|altcoin|blockchain|defi|nft|coinbase|binance|satoshi|stablecoin|\busdt\b|\busdc\b/.test(q)) return 'macro';
  if (/mercado|bolsa|[ií]ndice|s&p|sp500|nasdaq|dow\b|dax\b|ibex|\bfed\b|\bbce\b|banco.central|inflaci|tipos.de.inter[eé]s|euribor|\bpib\b|desempleo|paro\b|\bmacro\b|bono\b|yield\b|spread\b|econom[ií]a|noticias|cotiza|precio.de|resultados.de|earnings|dato.de|esta.semana|hoy\b|ahora\b/.test(q)) return 'macro';

  // Default: AURUM — general financial advice, portfolio strategy
  return 'aurum';
}
