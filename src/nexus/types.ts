export type Provider = 'anthropic' | 'openai' | 'deepseek';
export type AgentKey = 'aurum' | 'macro' | 'riesgo' | 'fiscal';
export type ResearchTask = 'news' | 'financials' | 'analysts' | 'macro' | 'risks' | 'synthesis' | 'prices';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | unknown[];
}

export interface DisplayMessage {
  role: 'user' | 'assistant';
  content: string;
  provider?: Provider;
  model?: string;
}

export interface Position {
  id: number;
  ticker: string;
  name: string;
  shares: number;
  avgPrice: number;
  currentPrice: number;
}

export interface UserMemory {
  facts: string[];
  interactions: number;
  lastUpdated: number;
}

export interface RouteResult {
  provider: Provider;
  model: string;
}

export const PROVIDER_META: Record<Provider, { label: string; color: string; short: string }> = {
  anthropic: { label: 'Claude',     color: '#c9a84c', short: 'Claude'    },
  openai:    { label: 'GPT-4o',     color: '#2a9d6e', short: 'GPT-4o'    },
  deepseek:  { label: 'DeepSeek',   color: '#9b6cf6', short: 'DeepSeek'  },
};
