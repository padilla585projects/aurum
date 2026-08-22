import type { ChatMessage, RouteResult } from './types';
import { updateTokenBudget } from './tokens';

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

/**
 * Proveedores cuya clave aporta cada usuario desde Ajustes. No tienen variante
 * de desarrollo directo: la clave vive cifrada en el servidor, asi que la
 * llamada siempre pasa por el proxy.
 */
const BYOK_URLS: Record<'gemini' | 'grok' | 'openrouter', string> = {
  gemini:     '/api/gemini',
  grok:       '/api/grok',
  openrouter: '/api/openrouter',
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Si se proporciona contextPrefix, lo inyecta al PRINCIPIO del primer mensaje
 * de tipo 'user' en lugar de incluirlo en el system prompt.
 * Esto mantiene el system prompt 100% estático → cache hits máximos.
 */
function injectContext(messages: ChatMessage[], prefix: string): ChatMessage[] {
  if (!prefix.trim()) return messages;
  const idx = messages.findIndex(m => m.role === 'user');
  if (idx === -1) return messages;
  const arr = [...messages];
  const msg = arr[idx];
  const original = typeof msg.content === 'string' ? msg.content : '';
  arr[idx] = { ...msg, content: `${prefix}\n\n---\n\n${original}` };
  return arr;
}

// ── Anthropic / Claude ──────────────────────────────────────────────────────
// System prompt enviado como array con cache_control para máxima caché (90% descuento en hits).
// contextPrefix: contexto dinámico (portfolio, usuario) inyectado en el primer mensaje user,
// NO en el system prompt → permite que el system sea siempre idéntico y caché siempre hits.
export async function callAnthropic(
  messages:      ChatMessage[],
  system:        string,
  model:         string,
  onSearch?:     () => void,
  maxTokens   =  1024,
  useWebSearch = false,           // ← default FALSE (opt-in, no opt-out)
  contextPrefix?: string,         // contexto dinámico → primer mensaje user
): Promise<string> {
  const headers: Record<string, string> = {
    'Content-Type':   'application/json',
    'anthropic-beta': 'prompt-caching-2024-07-31',
  };
  if (isDev) {
    headers['x-api-key']         = import.meta.env.VITE_ANTHROPIC_API_KEY || '';
    headers['anthropic-version'] = '2023-06-01';
  }

  // Inyectar contexto dinámico en user message (no en system)
  let cur = contextPrefix ? injectContext(messages, contextPrefix) : [...messages];

  let webSearchUsed = false;

  for (let i = 0; i < 8; i++) {
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      // System 100% estático → siempre cacheado
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: cur,
    };
    if (useWebSearch) {
      body['tools'] = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }];
    }

    const res = await fetch(urls.anthropic, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Claude ${res.status}: ${await res.text()}`);
    const data = await res.json();

    // Tracking de tokens (siempre disponible en la respuesta)
    if (data.usage) updateTokenBudget(data.usage, webSearchUsed);

    const texto: string = (data.content ?? [])
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
      .trim();

    if (data.stop_reason === 'end_turn') return texto;

    // Los turnos largos con herramientas de servidor se interrumpen con
    // pause_turn: hay que continuar la conversacion, no darla por terminada.
    if (data.stop_reason === 'pause_turn') {
      cur.push({ role: 'assistant', content: data.content });
      continue;
    }

    if (data.stop_reason === 'tool_use' && useWebSearch) {
      webSearchUsed = true;
      if (onSearch) onSearch();
      cur.push({ role: 'assistant', content: data.content });
      cur.push({
        role: 'user',
        content: data.content
          .filter((b: any) => b.type === 'tool_use')
          .map((b: any) => ({ type: 'tool_result', tool_use_id: b.id, content: 'Search executed' })),
      });
    } else {
      // max_tokens, stop_sequence, refusal... Devolver lo generado en lugar de
      // tirarlo: esos tokens ya se han pagado, y una respuesta cortada es mas
      // util que un «Sin respuesta».
      if (texto) return texto;
      break;
    }
  }
  return 'Sin respuesta.';
}

// ── OpenAI / GPT-4o ─────────────────────────────────────────────────────────
export async function callOpenAI(
  messages:     ChatMessage[],
  system:       string,
  model:        string,
  maxTokens  =  1024,
  useWebSearch = false,
  contextPrefix?: string,
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isDev) headers['Authorization'] = `Bearer ${import.meta.env.VITE_OPENAI_API_KEY || ''}`;

  const msgs = contextPrefix ? injectContext(messages, contextPrefix) : messages;
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'system', content: system }, ...msgs],
    max_tokens: maxTokens,
  };
  if (useWebSearch && model.includes('search')) {
    body['web_search_options'] = { search_context_size: 'medium' };
  }

  const res = await fetch(urls.openai, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  // Tracking OpenAI usage
  if (data.usage) updateTokenBudget({
    input_tokens:  data.usage.prompt_tokens,
    output_tokens: data.usage.completion_tokens,
  }, useWebSearch);
  const contenido = data.choices?.[0]?.message?.content?.trim();
  if (contenido) return contenido;

  // Un modelo de razonamiento puede gastarse el presupuesto pensando y no
  // llegar a escribir nada. «Sin respuesta» no dice que hacer; esto si.
  if (data.choices?.[0]?.finish_reason === 'length') {
    return 'El modelo se ha quedado sin espacio antes de responder. '
      + 'Prueba a elegir otro modelo para este proveedor en Ajustes → Claves de IA.';
  }
  return 'Sin respuesta.';
}

// ── DeepSeek / R1 + V3 ──────────────────────────────────────────────────────
export async function callDeepSeek(
  messages:  ChatMessage[],
  system:    string,
  model:     string,
  maxTokens = 2048,
  contextPrefix?: string,
): Promise<string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (isDev) headers['Authorization'] = `Bearer ${import.meta.env.VITE_DEEPSEEK_API_KEY || ''}`;

  const msgs = contextPrefix ? injectContext(messages, contextPrefix) : messages;
  const res = await fetch(urls.deepseek, {
    method: 'POST', headers,
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...msgs],
      max_tokens: maxTokens,
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (data.usage) updateTokenBudget({
    input_tokens:  data.usage.prompt_tokens,
    output_tokens: data.usage.completion_tokens,
  });
  return data.choices?.[0]?.message?.content?.trim() || 'Sin respuesta.';
}

// ── Dispatcher unificado ─────────────────────────────────────────────────────
// ── Proveedores con clave del usuario (Gemini, Grok, OpenRouter) ────────────
// Los tres exponen el formato de chat de OpenAI, asi que comparten una sola
// implementacion. El modelo lo decide el servidor a partir de lo que el usuario
// guardo en Ajustes; el que se manda aqui es solo el valor por defecto.
/**
 * Marcador para las rutas cuyo modelo decide el usuario en Ajustes. El servidor
 * lo sustituye por el que este guardado, y si no hay ninguno responde 503 y
 * entra el respaldo. Nunca llega asi a un proveedor.
 */
export const MODELO_DE_AJUSTES = 'definido-en-ajustes';

/** Motivo por el que una ruta no puede atender: dispara el respaldo. */
export class RutaNoDisponible extends Error {}

/**
 * Traduce el contenido del formato de bloques de Anthropic al de OpenAI, que es
 * el que hablan Gemini, Grok y OpenRouter.
 *
 * Los PDF no tienen equivalente en ese formato, asi que en lugar de mandarlos
 * mutilados se rechaza la ruta y el respaldo los lleva a Claude, que si los lee.
 */
function aFormatoOpenAI(content: string | unknown[]): string | unknown[] {
  if (typeof content === 'string') return content;

  return content.map(bloque => {
    const b = bloque as { type?: string; text?: string; source?: { type?: string; media_type?: string; data?: string } };
    if (b?.type === 'text') return { type: 'text', text: b.text ?? '' };
    if (b?.type === 'image' && b.source?.type === 'base64') {
      return {
        type: 'image_url',
        image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
      };
    }
    throw new RutaNoDisponible(`Contenido no soportado por este proveedor: ${b?.type ?? 'desconocido'}`);
  });
}

export async function callByok(
  provider:      'gemini' | 'grok' | 'openrouter',
  messages:      ChatMessage[],
  system:        string,
  model:         string,
  maxTokens   =  1024,
  contextPrefix?: string,
): Promise<string> {
  const msgs = (contextPrefix ? injectContext(messages, contextPrefix) : messages)
    .map(m => ({ ...m, content: aFormatoOpenAI(m.content) }));

  const res = await fetch(BYOK_URLS[provider], {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      model,
      messages: [{ role: 'system', content: system }, ...msgs],
      max_tokens: maxTokens,
    }),
  });

  if (!res.ok) {
    const detalle = await res.text();
    // 503 significa que falta la clave de ese proveedor: no es un fallo, es que
    // el usuario no lo ha configurado, y entonces manda el respaldo.
    if (res.status === 503) throw new RutaNoDisponible(`${provider} sin configurar`);
    throw new Error(`${provider} ${res.status}: ${detalle.slice(0, 300)}`);
  }

  const data = await res.json();
  if (data.usage) updateTokenBudget({
    input_tokens:  data.usage.prompt_tokens,
    output_tokens: data.usage.completion_tokens,
  });
  return data.choices?.[0]?.message?.content?.trim() || 'Sin respuesta.';
}

export async function callProvider(
  route:          RouteResult,
  messages:       ChatMessage[],
  system:         string,
  onSearch?:      () => void,
  maxTokens?:     number,
  useWebSearch?:  boolean,
  contextPrefix?: string,
): Promise<string> {
  try {
    return await despachar(route, messages, system, onSearch, maxTokens, useWebSearch, contextPrefix);
  } catch (err) {
    // Ruta no disponible: se intenta el respaldo antes de dar la funcion por rota.
    if (err instanceof RutaNoDisponible && route.fallback) {
      return despachar(route.fallback, messages, system, onSearch, maxTokens, useWebSearch, contextPrefix);
    }
    throw err;
  }
}

async function despachar(
  route:          RouteResult,
  messages:       ChatMessage[],
  system:         string,
  onSearch?:      () => void,
  maxTokens?:     number,
  useWebSearch?:  boolean,
  contextPrefix?: string,
): Promise<string> {
  switch (route.provider) {
    case 'anthropic':
      return callAnthropic(messages, system, route.model, onSearch, maxTokens, useWebSearch, contextPrefix);
    case 'openai':
      return callOpenAI(messages, system, route.model, maxTokens, useWebSearch, contextPrefix);
    case 'deepseek':
      return callDeepSeek(messages, system, route.model, maxTokens, contextPrefix);
    case 'gemini':
    case 'grok':
    case 'openrouter':
      return callByok(route.provider, messages, system, route.model, maxTokens, contextPrefix);
  }
}
