/**
 * Proxy de la API de Anthropic.
 *
 * Requiere sesión: el middleware de /api rechaza la petición antes de llegar
 * aquí si no hay usuario. Reenvía `anthropic-beta` para que el prompt-caching
 * siga funcionando en producción (ahorra ~90% de los tokens del system prompt).
 *
 * El cuerpo se vuelve a serializar tras validarlo. El orden de las claves se
 * conserva, así que el prefijo cacheado sigue siendo idéntico.
 */

import type { PagesContext } from '../_lib/types.ts';
import { fail } from '../_lib/http.ts';
import { extractUsage, recordUsage, validateBody } from '../_lib/ai-proxy.ts';

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const { request, env, data } = context;
  const user = data.user;
  if (!user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');
  const validated = await validateBody(request, 'anthropic');
  if (validated instanceof Response) return validated;

  if (!env.ANTHROPIC_API_KEY) return fail(503, 'provider_disabled', 'ANTHROPIC_API_KEY no está configurada.');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  const beta = request.headers.get('anthropic-beta');
  if (beta) headers['anthropic-beta'] = beta;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(validated.body),
  });

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    // Respuesta no-JSON del proveedor: se reenvía tal cual y se registra sin consumo.
  }

  context.waitUntil(
    recordUsage(env, user, 'anthropic', validated.model, res.status, extractUsage('anthropic', payload)),
  );

  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
