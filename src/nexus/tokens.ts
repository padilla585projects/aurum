import type { ChatMessage } from './types';

// ~3.8 chars per token for Spanish text (conservative estimate)
export const estimateTokens = (text: string): number =>
  Math.ceil(text.replace(/\s+/g, ' ').length / 3.8);

export function estimateHistory(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => {
    const s = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return n + estimateTokens(s) + 5; // +5 overhead per message
  }, 0);
}

const MAX_HISTORY_TOKENS = 4000;
const KEEP_RECENT = 8; // always preserve last 8 messages verbatim

export function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= KEEP_RECENT) return messages;
  if (estimateHistory(messages) <= MAX_HISTORY_TOKENS) return messages;

  const recent = messages.slice(-KEEP_RECENT);
  const older  = messages.slice(0, -KEEP_RECENT);

  // Build a compact summary of the older exchanges
  const summary = older
    .map(m => {
      const label = m.role === 'user' ? 'U' : 'A';
      const txt   = typeof m.content === 'string' ? m.content.slice(0, 100) : '[adjunto]';
      return `${label}: ${txt}`;
    })
    .join(' | ');

  const summaryMsg: ChatMessage = {
    role: 'user',
    content: `[Resumen comprimido de conversación anterior — ${older.length} mensajes: ${summary}]`,
  };

  return [summaryMsg, ...recent];
}
