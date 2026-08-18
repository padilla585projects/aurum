/**
 * Proxy de la API de OpenAI. Requiere sesión (ver functions/api/_middleware.ts).
 */

import type { PagesContext } from '../_lib/types.ts';
import { fail } from '../_lib/http.ts';
import { extractUsage, recordUsage, validateBody } from '../_lib/ai-proxy.ts';

export async function onRequestPost(context: PagesContext): Promise<Response> {
  const { request, env, data } = context;
  const user = data.user;
  if (!user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');
  const validated = await validateBody(request, 'openai');
  if (validated instanceof Response) return validated;

  if (!env.OPENAI_API_KEY) return fail(503, 'provider_disabled', 'OPENAI_API_KEY no está configurada.');

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(validated.body),
  });

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = JSON.parse(text);
  } catch {
    /* respuesta no-JSON: se reenvía sin registrar consumo */
  }

  context.waitUntil(
    recordUsage(env, user, 'openai', validated.model, res.status, extractUsage('openai', payload)),
  );

  return new Response(text, {
    status: res.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
