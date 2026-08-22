/**
 * Proxies de IA y precios de mercado.
 *
 * Los proxies existen para que las claves de los proveedores no lleguen al
 * navegador. Con multiusuario hacen falta dos garantías más, y son las que se
 * comprueban aquí: que nadie pueda pedir un modelo fuera de la lista ni un
 * número arbitrario de tokens con la clave del proyecto, y que cada llamada
 * quede imputada a quien la hizo.
 */

import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_OUTPUT_TOKENS,
  PROVIDERS,
  extractUsage,
  validateBody,
  type Credentials,
} from '../../functions/_lib/ai-proxy.ts';
import { dispatch, seedLoggedIn } from './helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Sustituye la salida a internet por una respuesta fija y registra la llamada. */
function interceptarFetch(responder: (url: string, init: RequestInit) => Response): ReturnType<typeof vi.fn> {
  const espia = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) =>
    responder(typeof input === 'string' ? input : String(input), init),
  );
  vi.stubGlobal('fetch', espia);
  return espia;
}

function respuestaJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const CUERPO_VALIDO = {
  model: 'claude-sonnet-4-6',
  max_tokens: 1024,
  messages: [{ role: 'user', content: 'hola' }],
};

describe('validateBody', () => {
  /** Clave del proyecto: es el caso en el que la allowlist tiene que aplicar. */
  const DEL_PROYECTO: Credentials = { key: 'k', source: 'project', model: null };
  /** Clave del usuario: elige el modelo porque el gasto es suyo. */
  const DEL_USUARIO: Credentials = { key: 'k', source: 'user', model: null };

  function peticion(body: unknown): Request {
    return new Request('https://aurum.test/api/anthropic', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  it('acepta los modelos que AURUM usa de verdad', async () => {
    for (const model of PROVIDERS.anthropic.allowed!) {
      const result = await validateBody(peticion({ ...CUERPO_VALIDO, model }), 'anthropic', DEL_PROYECTO);
      expect(result).not.toBeInstanceOf(Response);
      expect((result as { model: string }).model).toBe(model);
    }
  });

  it('rechaza cualquier otro modelo, aunque exista en el proveedor', async () => {
    const result = await validateBody(peticion({ ...CUERPO_VALIDO, model: 'claude-3-opus-20240229' }), 'anthropic', DEL_PROYECTO);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
    expect(await (result as Response).json()).toMatchObject({ error: { code: 'model_not_allowed' } });
  });

  it('no deja colar el modelo de un proveedor en otro', async () => {
    const result = await validateBody(peticion({ ...CUERPO_VALIDO, model: 'gpt-4o' }), 'anthropic', DEL_PROYECTO);
    expect(result).toBeInstanceOf(Response);
  });

  it('acota los tokens de salida, en los dos nombres de campo', async () => {
    const anthropic = await validateBody(peticion({ ...CUERPO_VALIDO, max_tokens: 200_000 }), 'anthropic', DEL_PROYECTO);
    expect((anthropic as { body: Record<string, unknown> }).body.max_tokens).toBe(MAX_OUTPUT_TOKENS);

    const openai = await validateBody(
      peticion({ model: 'gpt-4o', max_completion_tokens: 200_000 }),
      'openai',
      DEL_PROYECTO,
    );
    expect((openai as { body: Record<string, unknown> }).body.max_completion_tokens).toBe(MAX_OUTPUT_TOKENS);
  });

  it('respeta una petición por debajo del tope', async () => {
    const result = await validateBody(peticion({ ...CUERPO_VALIDO, max_tokens: 512 }), 'anthropic', DEL_PROYECTO);
    expect((result as { body: Record<string, unknown> }).body.max_tokens).toBe(512);
  });

  it('rechaza cuerpos que no son JSON o que son demasiado grandes', async () => {
    const roto = (await validateBody(peticion('no soy json'), 'anthropic', DEL_PROYECTO)) as Response;
    expect(roto.status).toBe(400);

    const enorme = (await validateBody(
      peticion({ ...CUERPO_VALIDO, messages: [{ role: 'user', content: 'x'.repeat(513 * 1024) }] }),
      'anthropic',
    )) as Response;
    expect(enorme.status).toBe(413);
  });
});

describe('extractUsage', () => {
  it('lee los nombres de campo de cada API', () => {
    expect(
      extractUsage('anthropic', { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7 } }),
    ).toEqual({ input: 10, output: 5, cached: 7 });

    expect(
      extractUsage('openai', { usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 7 } } }),
    ).toEqual({ input: 10, output: 5, cached: 7 });

    expect(
      extractUsage('deepseek', { usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 7 } }),
    ).toEqual({ input: 10, output: 5, cached: 7 });
  });

  it('devuelve ceros cuando el proveedor no informa del consumo', () => {
    expect(extractUsage('anthropic', null)).toEqual({ input: 0, output: 0, cached: 0 });
    expect(extractUsage('anthropic', { usage: {} })).toEqual({ input: 0, output: 0, cached: 0 });
    expect(extractUsage('openai', { usage: { prompt_tokens: 'muchos' } })).toEqual({ input: 0, output: 0, cached: 0 });
  });
});

describe('proxy de Anthropic', () => {
  it('no responde sin sesión, y sin llegar a llamar al proveedor', async () => {
    const espia = interceptarFetch(() => respuestaJson({}));
    const res = await dispatch('/api/anthropic', { method: 'POST', body: CUERPO_VALIDO });
    expect(res.status).toBe(401);
    expect(espia).not.toHaveBeenCalled();
  });

  it('falla de forma explícita si la clave del proveedor no está configurada', async () => {
    const { token } = await seedLoggedIn();
    const res = await dispatch('/api/anthropic', { method: 'POST', bearer: token, body: CUERPO_VALIDO });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'provider_not_configured' } });
  });

  it('reenvía la petición con la clave del proyecto y anota el consumo del usuario', async () => {
    const { user, token } = await seedLoggedIn();
    const espia = interceptarFetch(() =>
      respuestaJson({ content: [{ type: 'text', text: 'hola' }], usage: { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 100 } }),
    );

    const res = await dispatch('/api/anthropic', {
      method: 'POST',
      bearer: token,
      headers: { 'anthropic-beta': 'prompt-caching-2024-07-31' },
      body: { ...CUERPO_VALIDO, max_tokens: 999_999 },
      envOverrides: { ANTHROPIC_API_KEY: 'clave-del-proyecto' },
    });

    expect(res.status).toBe(200);
    expect(espia).toHaveBeenCalledTimes(1);

    const [url, init] = espia.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('clave-del-proyecto');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    // El prompt caching depende de que la cabecera beta llegue al proveedor.
    expect(headers['anthropic-beta']).toBe('prompt-caching-2024-07-31');
    // Y el tope de tokens se aplica antes de salir.
    expect(JSON.parse(init.body as string).max_tokens).toBe(MAX_OUTPUT_TOKENS);

    const uso = await env.DB.prepare('SELECT * FROM ai_usage WHERE user_id = ?').bind(user.id).first<{
      provider: string; model: string; input_tokens: number; output_tokens: number; cached_tokens: number; status: number;
    }>();
    expect(uso).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      input_tokens: 120,
      output_tokens: 30,
      cached_tokens: 100,
      status: 200,
    });
  });

  it('reenvía el error del proveedor tal cual y lo deja registrado', async () => {
    const { user, token } = await seedLoggedIn();
    interceptarFetch(() => respuestaJson({ error: { type: 'overloaded_error' } }, 529));

    const res = await dispatch('/api/anthropic', {
      method: 'POST',
      bearer: token,
      body: CUERPO_VALIDO,
      envOverrides: { ANTHROPIC_API_KEY: 'clave-del-proyecto' },
    });

    expect(res.status).toBe(529);
    expect(await res.json()).toMatchObject({ error: { type: 'overloaded_error' } });

    const uso = await env.DB.prepare('SELECT status FROM ai_usage WHERE user_id = ?').bind(user.id).first<{ status: number }>();
    expect(uso?.status).toBe(529);
  });

  it('una respuesta que no es JSON se reenvía sin romper nada', async () => {
    const { token } = await seedLoggedIn();
    interceptarFetch(() => new Response('502 Bad Gateway', { status: 502 }));

    const res = await dispatch('/api/anthropic', {
      method: 'POST',
      bearer: token,
      body: CUERPO_VALIDO,
      envOverrides: { ANTHROPIC_API_KEY: 'clave-del-proyecto' },
    });
    expect(res.status).toBe(502);
    expect(await res.text()).toBe('502 Bad Gateway');
  });
});

describe('proxy de OpenAI', () => {
  it('manda la clave como Bearer y registra el proveedor correcto', async () => {
    const { user, token } = await seedLoggedIn();
    const espia = interceptarFetch(() =>
      respuestaJson({ usage: { prompt_tokens: 8, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 2 } } }),
    );

    const res = await dispatch('/api/openai', {
      method: 'POST',
      bearer: token,
      body: { model: 'gpt-4o', messages: [{ role: 'user', content: 'hola' }] },
      envOverrides: { OPENAI_API_KEY: 'clave-openai' },
    });

    expect(res.status).toBe(200);
    const [url, init] = espia.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer clave-openai');

    const uso = await env.DB.prepare('SELECT provider, cached_tokens FROM ai_usage WHERE user_id = ?').bind(user.id).first<{ provider: string; cached_tokens: number }>();
    expect(uso).toMatchObject({ provider: 'openai', cached_tokens: 2 });
  });
});

describe('parámetros que solo valen para el modelo pedido', () => {
  it('la búsqueda web se quita si el modelo que acaba yendo no la admite', async () => {
    // El cliente elige un modelo con búsqueda y añade web_search_options; el
    // servidor sustituye el modelo por el del usuario, y OpenAI rechazaba la
    // petición entera con «Unknown parameter».
    const { token } = await seedLoggedIn();
    await dispatch('/api/keys', { method: 'PUT', bearer: token,
      body: { provider: 'openai', key: 'sk-propia-de-prueba', model: 'gpt-5-mini' } });
    const espia = interceptarFetch(() => respuestaJson({ choices: [{ message: { content: 'ok' } }] }));

    await dispatch('/api/openai', {
      method: 'POST', bearer: token,
      body: { model: 'gpt-4o-search-preview', messages: [], web_search_options: { search_context_size: 'medium' } },
    });

    const enviado = JSON.parse((espia.mock.calls[0][1] as RequestInit).body as string);
    expect(enviado.model).toBe('gpt-5-mini');
    expect(enviado.web_search_options).toBeUndefined();
  });

  it('con un modelo de búsqueda se respeta', async () => {
    const { token } = await seedLoggedIn();
    await dispatch('/api/keys', { method: 'PUT', bearer: token,
      body: { provider: 'openai', key: 'sk-propia-de-prueba', model: 'gpt-4o-search-preview' } });
    const espia = interceptarFetch(() => respuestaJson({ choices: [{ message: { content: 'ok' } }] }));

    await dispatch('/api/openai', {
      method: 'POST', bearer: token,
      body: { model: 'gpt-4o-search-preview', messages: [], web_search_options: { search_context_size: 'medium' } },
    });

    const enviado = JSON.parse((espia.mock.calls[0][1] as RequestInit).body as string);
    expect(enviado.web_search_options).toEqual({ search_context_size: 'medium' });
  });
});
