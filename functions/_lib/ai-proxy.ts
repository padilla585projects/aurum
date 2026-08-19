/**
 * Lógica común de los proxies de IA.
 *
 * Los proxies existen para que las claves de los proveedores no salgan nunca al
 * navegador. Con multiusuario hay que añadir dos cosas más:
 *
 *   1. Una allowlist de modelos. Sin ella, cualquier usuario autenticado podría
 *      pedir el modelo más caro del catálogo con la clave del proyecto.
 *   2. Registro de consumo por usuario, para poder ver quién gasta qué.
 */

import type { Env, SessionUser } from './types.ts';
import { fail } from './http.ts';

/** Modelos que AURUM usa de verdad (ver src/nexus/router.ts). */
export const ALLOWED_MODELS: Record<string, string[]> = {
  // Sonnet 4.6 se mantiene durante la transicion: una pestaña abierta desde
  // antes del despliegue sigue pidiendolo hasta que se recargue.
  anthropic: ['claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-4o-search-preview', 'gpt-4o', 'gpt-4o-mini'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
};

/** Tope de tokens de salida por petición, para acotar el coste de un fallo. */
export const MAX_OUTPUT_TOKENS = 8192;

/** Tamaño máximo del cuerpo aceptado hacia el proveedor. */
export const MAX_BODY_BYTES = 512 * 1024;

export type Provider = 'anthropic' | 'openai' | 'deepseek';

interface ValidatedBody {
  body: Record<string, unknown>;
  model: string;
}

/**
 * Valida el cuerpo entrante: JSON, tamaño, modelo permitido y tope de tokens.
 * Devuelve el cuerpo ya normalizado o una respuesta de error lista para enviar.
 */
export async function validateBody(
  request: Request,
  provider: Provider,
): Promise<ValidatedBody | Response> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return fail(413, 'body_too_large', 'La petición es demasiado grande.');
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return fail(400, 'bad_request', 'El cuerpo no es JSON válido.');
  }

  const model = typeof body.model === 'string' ? body.model : '';
  if (!ALLOWED_MODELS[provider].includes(model)) {
    return fail(400, 'model_not_allowed', `Modelo no permitido para ${provider}.`);
  }

  const requested = typeof body.max_tokens === 'number' ? body.max_tokens : undefined;
  if (requested !== undefined) {
    body.max_tokens = Math.min(requested, MAX_OUTPUT_TOKENS);
  }
  // El equivalente en la API de chat de OpenAI.
  const requestedCompletion = typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined;
  if (requestedCompletion !== undefined) {
    body.max_completion_tokens = Math.min(requestedCompletion, MAX_OUTPUT_TOKENS);
  }

  return { body, model };
}

interface UsageCounts {
  input: number;
  output: number;
  cached: number;
}

/** Extrae el consumo de la respuesta, con los nombres de campo de cada API. */
export function extractUsage(provider: Provider, payload: unknown): UsageCounts {
  const usage = (payload as { usage?: Record<string, unknown> } | null)?.usage;
  if (!usage) return { input: 0, output: 0, cached: 0 };

  const num = (v: unknown) => (typeof v === 'number' ? v : 0);

  if (provider === 'anthropic') {
    return {
      input: num(usage.input_tokens),
      output: num(usage.output_tokens),
      cached: num(usage.cache_read_input_tokens),
    };
  }
  // OpenAI y DeepSeek comparten forma.
  const details = usage.prompt_tokens_details as { cached_tokens?: unknown } | undefined;
  return {
    input: num(usage.prompt_tokens),
    output: num(usage.completion_tokens),
    cached: num(details?.cached_tokens) || num(usage.prompt_cache_hit_tokens),
  };
}

/** Motivo de parada, para poder diagnosticar respuestas que el cliente descarta. */
export function extractStopReason(provider: Provider, payload: unknown): string | null {
  const p = payload as Record<string, unknown> | null;
  if (!p) return null;
  if (provider === 'anthropic') return typeof p.stop_reason === 'string' ? p.stop_reason : null;
  const choice = (p.choices as { finish_reason?: unknown }[] | undefined)?.[0];
  return typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
}

export async function recordUsage(
  env: Env,
  user: SessionUser,
  provider: Provider,
  model: string,
  status: number,
  usage: UsageCounts,
  stopReason: string | null = null,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO ai_usage (ts, user_id, provider, model, input_tokens, output_tokens, cached_tokens, status, stop_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(Date.now(), user.id, provider, model, usage.input, usage.output, usage.cached, status, stopReason).run();
  } catch {
    // El registro de consumo no debe impedir que el usuario reciba su respuesta.
  }
}
