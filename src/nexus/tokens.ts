import type { ChatMessage } from './types';
import * as store from '../store/state';

// ── Estimación de tokens ───────────────────────────────────────────────────
// ~3.8 chars/token para español
export const estimateTokens = (text: string): number =>
  Math.ceil(text.replace(/\s+/g, ' ').length / 3.8);

export function estimateHistory(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => {
    const s = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return n + estimateTokens(s) + 5;
  }, 0);
}

// ── Recorte de historial ───────────────────────────────────────────────────
const MAX_HISTORY_TOKENS = 3200;
const KEEP_RECENT        = 6;

function compressMsg(content: string): string {
  const s       = content.slice(0, 120);
  const tickers = (content.match(/\b[A-Z]{2,5}\b/g) || []).slice(0, 5).join(',');
  const numbers = (content.match(/[\d,.]+[€%$]?/g) || []).slice(0, 4).join(' ');
  const extra   = tickers || numbers ? ` [${[tickers, numbers].filter(Boolean).join('|')}]` : '';
  return s + extra;
}

export function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= KEEP_RECENT) return messages;
  if (estimateHistory(messages) <= MAX_HISTORY_TOKENS) return messages;

  const recent = messages.slice(-KEEP_RECENT);
  const older  = messages.slice(0, -KEEP_RECENT);

  const compressed = older.map(m => {
    const label = m.role === 'user' ? 'U' : 'A';
    const txt   = typeof m.content === 'string' ? compressMsg(m.content) : '[img/doc]';
    return `${label}:${txt}`;
  }).join('|');

  return [
    { role: 'user',      content: `[Resumen de conversación anterior (${older.length} msgs)]` },
    { role: 'assistant', content: `[OK. Contexto comprimido: ${compressed}]` },
    ...recent,
  ];
}

// ── max_tokens óptimos por tipo de tarea ──────────────────────────────────
export type TaskType =
  | 'chat_simple'      // respuestas cortas, definiciones
  | 'chat_live'        // datos en vivo, precios
  | 'chat_analytical'  // análisis de cartera
  | 'chat_full'        // análisis profundo completo
  | 'research_step'    // un paso del pipeline de research
  | 'synthesis'        // síntesis final de research
  | 'decision'         // decisión de inversión autónoma
  | 'debate'           // debate Toro/Oso (un lado)
  | 'verdict'          // veredicto final del debate
  | 'carta'            // carta del gestor mensual
  | 'briefing'         // market briefing diario
  | 'import';          // importación de cartera desde imagen

const MAX_TOKENS_MAP: Record<TaskType, number> = {
  chat_simple:     512,
  chat_live:       768,
  chat_analytical: 1536,
  chat_full:       2048,
  research_step:   1024,
  synthesis:       2048,
  decision:        1024,
  debate:          1024,
  verdict:          768,
  carta:           1536,
  briefing:        1024,
  import:           512,
};

export function maxTokensFor(task: TaskType): number {
  return MAX_TOKENS_MAP[task] ?? 1024;
}

// ── Detector de necesidad de web search ──────────────────────────────────
// Evita web search cuando la respuesta puede derivarse de datos locales o conocimiento
const WEB_REQUIRED_RE = /\b(hoy|ahora|precio.*(de|actual)|cotiza|noticias|esta.semana|[úu]ltimos.datos|tiempo.real|mercado.est[áa]|c[oó]mo.est[áa]|briefing|ayer|esta.mañana|esta.tarde|reciente|último|última|hoy.mismo|en.tiempo.real|datos.actuales|precio.actual|precio.hoy)\b/i;
const WEB_NEVER_RE    = /^(explica|qué.es|qué.son|define|diferencia.entre|cómo.funciona|para.qué.sirve|qué.significa|calcula|stress.test|rebalanc|tax.loss|drift|scoring|simul)/i;

export function needsWebSearch(query: string): boolean {
  if (WEB_NEVER_RE.test(query)) return false;
  if (WEB_REQUIRED_RE.test(query)) return true;
  // Queries largas o complejas con activos concretos → probablemente sí
  const hasSpecificAsset = /\b(VWCE|SPPW|MSFT|AAPL|NVDA|AMZN|TSLA|bitcoin|ethereum|BTC|ETH|IBEX|S&P|nasdaq)\b/i.test(query);
  return hasSpecificAsset && query.length > 60;
}

// ── Budget de tokens (tracking de uso real) ───────────────────────────────
const BUDGET_KEY = 'aurum-token-budget-v1';

export interface TokenBudget {
  inputTokens:         number;
  outputTokens:        number;
  cacheCreationTokens: number;
  cacheReadTokens:     number;
  webSearchCalls:      number;
  apiCalls:            number;
  periodStart:         number;  // timestamp inicio del período
}

const EMPTY_BUDGET: TokenBudget = {
  inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0,
  cacheReadTokens: 0, webSearchCalls: 0, apiCalls: 0,
  periodStart: Date.now(),
};

export function loadTokenBudget(): TokenBudget {
  const b = store.get<TokenBudget | null>(BUDGET_KEY, null);
  if (!b) return { ...EMPTY_BUDGET, periodStart: Date.now() };
  // Reset mensual automático
  const ageMs = Date.now() - (b.periodStart || 0);
  if (ageMs > 30 * 24 * 3600_000) return { ...EMPTY_BUDGET, periodStart: Date.now() };
  return b;
}

export function updateTokenBudget(usage: {
  input_tokens?:               number;
  output_tokens?:              number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?:    number;
}, hadWebSearch = false): void {
  try {
    const b = loadTokenBudget();
    b.inputTokens         += usage.input_tokens                || 0;
    b.outputTokens        += usage.output_tokens               || 0;
    b.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
    b.cacheReadTokens     += usage.cache_read_input_tokens     || 0;
    if (hadWebSearch) b.webSearchCalls++;
    b.apiCalls++;
    store.set(BUDGET_KEY, b);
  } catch {}
}

export function resetTokenBudget(): void {
  store.set(BUDGET_KEY, { ...EMPTY_BUDGET, periodStart: Date.now() });
}

// Coste estimado en € (usando precios Claude Sonnet 4.6 europeos aproximados)
// Input: $3/MTok → ~€2.75/MTok | Output: $15/MTok → ~€13.8/MTok
// Cache creation: $3.75/MTok → ~€3.45/MTok | Cache read: $0.30/MTok → ~€0.28/MTok
export function estimateCost(b: TokenBudget): number {
  const input    = (b.inputTokens         / 1_000_000) * 2.75;
  const output   = (b.outputTokens        / 1_000_000) * 13.8;
  const cCreate  = (b.cacheCreationTokens / 1_000_000) * 3.45;
  const cRead    = (b.cacheReadTokens     / 1_000_000) * 0.28;
  return +(input + output + cCreate + cRead).toFixed(4);
}

// ── Caché de datos de mercado ─────────────────────────────────────────────
// Evita llamadas repetidas a la API para datos que no cambian en 30 minutos
interface CacheEntry { value: string; ts: number }
const _cache = new Map<string, CacheEntry>();
const MARKET_CACHE_TTL = 30 * 60_000; // 30 min

export function cacheGet(key: string): string | null {
  const entry = _cache.get(key);
  if (!entry || Date.now() - entry.ts > MARKET_CACHE_TTL) return null;
  return entry.value;
}

export function cacheSet(key: string, value: string): void {
  _cache.set(key, { value, ts: Date.now() });
  if (_cache.size > 50) {
    const now = Date.now();
    for (const [k, v] of _cache) {
      if (now - v.ts > MARKET_CACHE_TTL) _cache.delete(k);
    }
  }
}

export function cacheClear(): void { _cache.clear(); }
