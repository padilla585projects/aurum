export type Provider = 'anthropic' | 'openai' | 'deepseek' | 'gemini' | 'grok' | 'openrouter';
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
  agent?: AgentKey;
}

export interface Position {
  id: number;
  ticker: string;
  name: string;
  shares: number;
  avgPrice: number;
  currentPrice: number;
}

export interface UserProfile {
  name: string;
  age: string;
  capital: string;
  income: string;
  horizon: string;
  broker: string;
  country: string;
  notes: string;
}

export interface UserMemory {
  facts: string[];
  interactions: number;
  lastUpdated: number;
}

export interface RouteResult {
  provider: Provider;
  model: string;
  /**
   * A donde ir si esta ruta no puede atender la peticion: normalmente porque
   * el usuario no ha configurado la clave de ese proveedor. Sin esto, activar
   * un proveedor nuevo romperia la funcion para quien no lo tenga puesto.
   */
  fallback?: RouteResult;
}

export const EMPTY_PROFILE: UserProfile = {
  name: '', age: '', capital: '', income: '', horizon: '', broker: '', country: 'España', notes: '',
};

export const PROVIDER_META: Record<Provider, { label: string; color: string; short: string }> = {
  anthropic: { label: 'Claude',     color: '#c9a84c', short: 'Claude'    },
  openai:    { label: 'GPT-4o',     color: '#2a9d6e', short: 'GPT-4o'    },
  deepseek:  { label: 'DeepSeek',   color: '#9b6cf6', short: 'DeepSeek'  },
  gemini:    { label: 'Gemini',     color: '#5b9cf6', short: 'Gemini'    },
  grok:      { label: 'Grok',       color: '#e8734a', short: 'Grok'      },
  openrouter:{ label: 'OpenRouter', color: '#1abc9c', short: 'OpenRouter'},
};
