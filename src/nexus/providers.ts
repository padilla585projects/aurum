import type { ChatMessage, RouteResult } from './types';

const isDev = import.meta.env.DEV;

const DEV_URLS = {
  anthropic: 'https://api.anthropic.com/v1/messages',
  openai:    'https://api.openai.com/v1/chat/completions',
  deepseek:  'https://api.deepseek.com/chat/completions',
};
const PROD_URLS = {
  anthropic: '/api/anthropic',
  openai:    '/api/openai',
  deepseek:  '/api/deepseek',
};
const urls = isDev ? DEV_URLS : PROD_URLS;

// ── Anthropic / Claude ─────────────────────────────────────────
// Supports web_search tool natively; loops on tool_use stop reason
export async function callAnthropic(
  messages: ChatMessage[],
  system: string,
  model: string,
  onSearch?: () => void,
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isDev) {
    headers['x-api-key']          = import.meta.env.VITE_ANTHROPIC_API_KEY || '';
    headers['anthropic-version']  = '2023-06-01';
  }

  let cur = [...messages];
  for (let i = 0; i < 8; i++) {
    const res = await fetch(urls.anthropic, {
      method: 'POST', headers,
      body: JSON.stringify({
        model, max_tokens: 2048, system, messages: cur,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
    const data = await res.json();

    if (data.stop_reason === 'end_turn') {
      return data.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
    }
    if (data.stop_reason === 'tool_use') {
      if (onSearch) onSearch();
      cur.push({ role: 'assistant', content: data.content });
      cur.push({
        role: 'user',
        content: data.content
          .filter((b: any) => b.type === 'tool_use')
          .map((b: any) => ({ type: 'tool_result', tool_use_id: b.id, content: 'Search executed' })),
      });
    } else break;
  }
  return 'Sin respuesta.';
}

// ── OpenAI / GPT-4o ───────────────────────────────────────────
// Uses gpt-4o-search-preview for live web data; standard completions otherwise
export async function callOpenAI(
  messages: ChatMessage[],
  system: string,
  model: string,
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isDev) headers['Authorization'] = `Bearer ${import.meta.env.VITE_OPENAI_API_KEY || ''}`;

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'system', content: system }, ...messages],
    max_tokens: 2048,
  };
  // Enable web search for search-preview models
  if (model.includes('search')) body['web_search_options'] = { search_context_size: 'medium' };

  const res = await fetch(urls.openai, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || 'Sin respuesta.';
}

// ── DeepSeek / R1 + V3 ───────────────────────────────────────
// deepseek-reasoner (R1) for deep math/reasoning; deepseek-chat (V3) for cost-efficient tasks
export async function callDeepSeek(
  messages: ChatMessage[],
  system: string,
  model: string,
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isDev) headers['Authorization'] = `Bearer ${import.meta.env.VITE_DEEPSEEK_API_KEY || ''}`;

  const res = await fetch(urls.deepseek, {
    method: 'POST', headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...messages],
      max_tokens: 4096,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // deepseek-reasoner returns reasoning_content + content; we surface only content
  return data.choices?.[0]?.message?.content?.trim() || 'Sin respuesta.';
}

// ── Unified dispatcher ────────────────────────────────────────
export async function callProvider(
  route: RouteResult,
  messages: ChatMessage[],
  system: string,
  onSearch?: () => void,
): Promise<string> {
  switch (route.provider) {
    case 'anthropic': return callAnthropic(messages, system, route.model, onSearch);
    case 'openai':    return callOpenAI(messages, system, route.model);
    case 'deepseek':  return callDeepSeek(messages, system, route.model);
  }
}
