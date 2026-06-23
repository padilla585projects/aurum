import type { ChatMessage } from './types';

// ~3.8 chars/token para español
export const estimateTokens = (text: string): number =>
  Math.ceil(text.replace(/\s+/g, ' ').length / 3.8);

export function estimateHistory(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => {
    const s = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return n + estimateTokens(s) + 5;
  }, 0);
}

const MAX_HISTORY_TOKENS = 3200;
const KEEP_RECENT        = 6;

// Comprime un mensaje extrayendo datos financieros clave (tickers, cifras, decisiones)
function compressMsg(content: string): string {
  const s = content.slice(0, 120);
  // Extraer tickers mencionados para no perderlos
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

  // Comprimir pares user/assistant para preservar decisiones clave
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

// ── Caché de datos de mercado ──────────────────────────────────────────────
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
  // Limpiar entradas viejas si hay muchas
  if (_cache.size > 50) {
    const now = Date.now();
    for (const [k, v] of _cache) {
      if (now - v.ts > MARKET_CACHE_TTL) _cache.delete(k);
    }
  }
}

export function cacheClear(): void { _cache.clear(); }
