/**
 * Proxy de proveedores de IA.
 *
 * Los proxies existen para que las claves no lleguen nunca al navegador. Con
 * multiusuario hay dos orígenes posibles para esa clave:
 *
 *   · La del proyecto, en las variables del despliegue. La comparten todos los
 *     usuarios, así que el gasto es del propietario y los modelos van
 *     restringidos por allowlist.
 *   · La del usuario, guardada cifrada desde Ajustes. Paga él, así que elige el
 *     modelo que quiera: la allowlist protege la cartera del proyecto, no la suya.
 *
 * El tope de `max_tokens` se aplica siempre, venga la clave de donde venga: es
 * una red contra un bucle que se desmande, no una medida de coste.
 */

import type { Env, SessionUser } from './types.ts';
import { fail } from './http.ts';
import { decryptSecret } from './secrets.ts';

export type Provider = 'anthropic' | 'openai' | 'deepseek' | 'gemini' | 'grok' | 'openrouter';

interface ProviderConfig {
  label: string;
  endpoint: string;
  /** 'anthropic' usa x-api-key; el resto, Authorization: Bearer. */
  auth: 'anthropic' | 'bearer';
  /** Clave del proyecto, si el despliegue la tiene configurada. */
  projectKey: (env: Env) => string | undefined;
  /** Modelos admitidos con la clave del proyecto. Sin lista, no se restringe. */
  allowed?: string[];
}

export const PROVIDERS: Record<Provider, ProviderConfig> = {
  anthropic: {
    label: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    auth: 'anthropic',
    projectKey: env => env.ANTHROPIC_API_KEY,
    // Sonnet 4.6 sigue admitido durante la transición: una pestaña abierta
    // desde antes del despliegue lo pide hasta que se recargue.
    allowed: ['claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  },
  openai: {
    label: 'OpenAI',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    auth: 'bearer',
    projectKey: env => env.OPENAI_API_KEY,
    allowed: ['gpt-4o-search-preview', 'gpt-4o', 'gpt-4o-mini'],
  },
  deepseek: {
    label: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/chat/completions',
    auth: 'bearer',
    projectKey: env => env.DEEPSEEK_API_KEY,
    allowed: ['deepseek-chat', 'deepseek-reasoner'],
  },
  // Los tres siguientes no tienen clave de proyecto: la trae cada usuario desde
  // Ajustes, así que tampoco llevan allowlist.
  gemini: {
    label: 'Gemini',
    // Capa de compatibilidad con OpenAI de Google, para no mantener un segundo
    // formato de petición y de respuesta.
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    auth: 'bearer',
    projectKey: env => env.GEMINI_API_KEY,
  },
  grok: {
    label: 'Grok',
    endpoint: 'https://api.x.ai/v1/chat/completions',
    auth: 'bearer',
    projectKey: env => env.XAI_API_KEY,
  },
  openrouter: {
    label: 'OpenRouter',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    auth: 'bearer',
    projectKey: env => env.OPENROUTER_API_KEY,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as Provider[];

export function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDER_IDS as string[]).includes(value);
}

/** Tope de tokens de salida por petición, para acotar el coste de un fallo. */
export const MAX_OUTPUT_TOKENS = 8192;

/** Tamaño máximo del cuerpo aceptado hacia el proveedor. */
export const MAX_BODY_BYTES = 512 * 1024;

/* ── Credenciales ────────────────────────────────────────────── */

export interface Credentials {
  key: string;
  /** De quién es el gasto: decide si se aplica la allowlist. */
  source: 'user' | 'project';
  /** Modelo preferido que el usuario dejó guardado, si lo hay. */
  model: string | null;
}

/**
 * Busca primero la clave del usuario y cae en la del proyecto. Devuelve null si
 * no hay ninguna, para responder 503 en lugar de llamar sin credencial.
 */
export async function resolveCredentials(
  env: Env,
  user: SessionUser,
  provider: Provider,
): Promise<Credentials | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT key_enc, model FROM user_provider_keys WHERE user_id = ? AND provider = ?`,
    ).bind(user.id, provider).first<{ key_enc: string; model: string | null }>();

    if (row) {
      const key = await decryptSecret(env.AURUM_SIGNING_SECRET, row.key_enc, `${user.id}:${provider}`);
      if (key) return { key, source: 'user', model: row.model };
      // Criptograma ilegible: se sigue con la del proyecto en vez de dejar al
      // usuario sin servicio por un dato corrupto.
    }
  } catch {
    // Fallo de lectura: se intenta con la clave del proyecto.
  }

  const projectKey = PROVIDERS[provider].projectKey(env);
  return projectKey ? { key: projectKey, source: 'project', model: null } : null;
}

/* ── Validación del cuerpo ───────────────────────────────────── */

interface ValidatedBody {
  body: Record<string, unknown>;
  model: string;
}

export async function validateBody(
  request: Request,
  provider: Provider,
  credentials: Credentials,
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

  // El modelo que el usuario dejó en Ajustes manda sobre el que pida el cliente:
  // es el que corresponde a su clave y a su catálogo.
  if (credentials.source === 'user' && credentials.model) {
    body.model = credentials.model;
  }

  const model = typeof body.model === 'string' ? body.model : '';
  if (!model) return fail(400, 'model_missing', 'Falta el modelo en la petición.');

  const allowed = PROVIDERS[provider].allowed;
  if (credentials.source === 'project' && allowed && !allowed.includes(model)) {
    return fail(400, 'model_not_allowed', `Modelo no permitido para ${PROVIDERS[provider].label}.`);
  }

  const requested = typeof body.max_tokens === 'number' ? body.max_tokens : undefined;
  if (requested !== undefined) body.max_tokens = Math.min(requested, MAX_OUTPUT_TOKENS);

  const requestedCompletion = typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined;
  if (requestedCompletion !== undefined) {
    body.max_completion_tokens = Math.min(requestedCompletion, MAX_OUTPUT_TOKENS);
  }

  return { body, model };
}

/* ── Consumo ─────────────────────────────────────────────────── */

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
  // El resto sigue el formato de OpenAI.
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

/* ── Manejador común ─────────────────────────────────────────── */

interface ProxyContext {
  request: Request;
  env: Env;
  data: { user?: SessionUser };
  waitUntil: (promise: Promise<unknown>) => void;
}

/**
 * Reenvía la petición al proveedor. Todos menos Anthropic hablan el formato de
 * OpenAI, así que comparten camino; lo propio de Anthropic son las cabeceras de
 * versión y de beta.
 */
export async function proxyToProvider(context: ProxyContext, provider: Provider): Promise<Response> {
  const { request, env, data } = context;
  const user = data.user;
  if (!user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  const config = PROVIDERS[provider];
  const credentials = await resolveCredentials(env, user, provider);
  if (!credentials) {
    return fail(
      503,
      'provider_not_configured',
      `${config.label} no está configurado. Añade tu clave en Ajustes → Claves de IA.`,
    );
  }

  // En los proveedores que aporta el usuario no se puede adivinar el catalogo:
  // el modelo tiene que salir de Ajustes. Se responde 503 —igual que si faltara
  // la clave— para que el cliente use su ruta de respaldo en vez de fallar.
  if (!config.allowed && credentials.source === 'user' && !credentials.model) {
    return fail(
      503,
      'model_not_configured',
      `Indica que modelo usar con tu clave de ${config.label} en Ajustes → Claves de IA.`,
    );
  }

  const validated = await validateBody(request, provider, credentials);
  if (validated instanceof Response) return validated;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.auth === 'anthropic') {
    headers['x-api-key'] = credentials.key;
    headers['anthropic-version'] = '2023-06-01';
    const beta = request.headers.get('anthropic-beta');
    if (beta) headers['anthropic-beta'] = beta;
  } else {
    headers.Authorization = `Bearer ${credentials.key}`;
  }
  if (provider === 'openrouter' && env.AURUM_PUBLIC_URL) {
    // Opcionales, solo para las clasificaciones de OpenRouter.
    headers['HTTP-Referer'] = env.AURUM_PUBLIC_URL;
    headers['X-Title'] = 'AURUM';
  }

  let res: Response;
  try {
    res = await fetch(config.endpoint, { method: 'POST', headers, body: JSON.stringify(validated.body) });
  } catch (err) {
    return fail(502, 'provider_unreachable', `No se ha podido contactar con ${config.label}: ${String(err).slice(0, 120)}`);
  }

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // Respuesta no-JSON del proveedor: se reenvía tal cual y se registra sin consumo.
  }

  context.waitUntil(
    recordUsage(
      env,
      user,
      provider,
      validated.model,
      res.status,
      extractUsage(provider, payload),
      extractStopReason(provider, payload),
    ),
  );

  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
