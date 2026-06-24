/**
 * Cloudflare Worker proxy para Anthropic API.
 *
 * Crítico: reenvía anthropic-beta para que el prompt-caching funcione
 * en producción (ahorra ~90% en tokens del system prompt).
 */

export async function onRequestPost(context: any) {
  const req = context.request;

  // Reenviar headers relevantes del frontend (especialmente anthropic-beta)
  const fwdHeaders: Record<string, string> = {
    'Content-Type':      'application/json',
    'x-api-key':         context.env.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };

  // Copiar cabeceras beta (prompt caching, extended thinking, etc.)
  const betaHeader = req.headers.get('anthropic-beta');
  if (betaHeader) fwdHeaders['anthropic-beta'] = betaHeader;

  const body = await req.text();   // raw text para no re-serializar

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method:  'POST',
    headers: fwdHeaders,
    body,
  });

  const data = await res.text();
  return new Response(data, {
    status: res.status,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, anthropic-beta, anthropic-version',
    },
  });
}
