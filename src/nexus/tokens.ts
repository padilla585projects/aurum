import type { ChatMessage } from './types';

// ~3.8 chars per token for Spanish text
export const estimateTokens = (text: string): number =>
  Math.ceil(text.replace(/\s+/g, ' ').length / 3.8);

export function estimateHistory(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => {
    const s = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return n + estimateTokens(s) + 5;
  }, 0);
}

const MAX_HISTORY_TOKENS = 3200;
const KEEP_RECENT = 6;

export function trimHistory(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= KEEP_RECENT) return messages;
  if (estimateHistory(messages) <= MAX_HISTORY_TOKENS) return messages;

  const recent = messages.slice(-KEEP_RECENT);
  const older  = messages.slice(0, -KEEP_RECENT);

  const summary = older
    .map(m => {
      const label = m.role === 'user' ? 'U' : 'A';
      const txt   = typeof m.content === 'string' ? m.content.slice(0, 80) : '[img]';
      return `${label}:${txt}`;
    })
    .join('|');

  const summaryMsg: ChatMessage = {
    role: 'user',
    content: `[Historial anterior comprimido(${older.length} msgs):${summary}]`,
  };

  return [summaryMsg, ...recent];
}
