import type { AgentKey, ResearchTask, RouteResult } from './types';

// Each agent is routed to the model best suited for its task:
// - AURUM (general)  → Claude: best conversational quality + web search
// - MACRO            → GPT-4o-search: live market data + structured analysis
// - RIESGO           → DeepSeek-R1: deep math reasoning (VaR, Sharpe, Kelly)
// - FISCAL           → Claude: nuanced Spanish tax law interpretation
const AGENT_ROUTES: Record<AgentKey, RouteResult> = {
  aurum:  { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  macro:  { provider: 'openai',    model: 'gpt-4o-search-preview'   },
  riesgo: { provider: 'deepseek',  model: 'deepseek-reasoner'        },
  fiscal: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
};

// Research pipeline: web-search steps via OpenAI, risk reasoning via DeepSeek, synthesis via Claude
const TASK_ROUTES: Record<ResearchTask, RouteResult> = {
  news:       { provider: 'openai',    model: 'gpt-4o-search-preview'   },
  financials: { provider: 'openai',    model: 'gpt-4o-search-preview'   },
  analysts:   { provider: 'openai',    model: 'gpt-4o-search-preview'   },
  macro:      { provider: 'openai',    model: 'gpt-4o-search-preview'   },
  risks:      { provider: 'deepseek',  model: 'deepseek-chat'            },
  synthesis:  { provider: 'anthropic', model: 'claude-sonnet-4-5' },
  prices:     { provider: 'openai',    model: 'gpt-4o-search-preview'   },
};

export const routeAgent = (key: AgentKey): RouteResult => AGENT_ROUTES[key];
export const routeTask  = (task: ResearchTask): RouteResult => TASK_ROUTES[task];
