/**
 * Claves de proveedor aportadas por el usuario.
 *
 * Lo que fija esta suite es la propiedad que hace segura la funcionalidad: una
 * clave que entra no vuelve a salir. Ni por la API, ni legible en la base de
 * datos, ni descifrable desde la fila de otro usuario.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, keyHint } from '../../functions/_lib/secrets.ts';
import { MODELO_AUTOMATICO, PROVIDERS, validateBody, type Credentials } from '../../functions/_lib/ai-proxy.ts';
import { elegirAutomatico } from '../../functions/api/models.ts';
import { dispatch, seedLoggedIn } from './helpers.ts';

const CLAVE = 'sk-secreta-de-prueba-1234567890';

describe('cifrado de secretos', () => {
  const SECRETO = 'secreto-de-firma-de-prueba';

  it('ida y vuelta con el mismo dueño', async () => {
    const cifrado = await encryptSecret(SECRETO, CLAVE, 'usuario-1:openai');
    expect(cifrado).not.toContain(CLAVE);
    expect(await decryptSecret(SECRETO, cifrado, 'usuario-1:openai')).toBe(CLAVE);
  });

  it('no se descifra desde otro usuario ni desde otro proveedor', async () => {
    const cifrado = await encryptSecret(SECRETO, CLAVE, 'usuario-1:openai');
    // Mover la fila a otro usuario en la base de datos no sirve de nada.
    expect(await decryptSecret(SECRETO, cifrado, 'usuario-2:openai')).toBeNull();
    expect(await decryptSecret(SECRETO, cifrado, 'usuario-1:grok')).toBeNull();
  });

  it('no se descifra con otro secreto de firma', async () => {
    const cifrado = await encryptSecret(SECRETO, CLAVE, 'usuario-1:openai');
    expect(await decryptSecret('otro-secreto-distinto', cifrado, 'usuario-1:openai')).toBeNull();
  });

  it('cada cifrado usa un nonce distinto', async () => {
    const a = await encryptSecret(SECRETO, CLAVE, 'usuario-1:openai');
    const b = await encryptSecret(SECRETO, CLAVE, 'usuario-1:openai');
    expect(a).not.toBe(b);
  });

  it('la pista no revela la clave', () => {
    const pista = keyHint(CLAVE);
    expect(pista).toBe('••••7890');
    expect(CLAVE).not.toContain(pista);
    expect(keyHint('corta')).toBe('••••');
  });
});

describe('/api/keys', () => {
  it('no responde sin sesión', async () => {
    expect((await dispatch('/api/keys')).status).toBe(401);
  });

  it('enumera los proveedores y marca de dónde sale cada clave', async () => {
    const { token } = await seedLoggedIn();
    const res = await dispatch('/api/keys', { bearer: token });
    expect(res.status).toBe(200);

    const { providers } = await res.json<{ providers: { id: string; hasOwnKey: boolean; hint: string | null }[] }>();
    expect(providers.map(p => p.id).sort()).toEqual(
      ['anthropic', 'deepseek', 'gemini', 'grok', 'openai', 'openrouter'],
    );
    for (const p of providers) {
      expect(p.hasOwnKey).toBe(false);
      expect(p.hint).toBeNull();
    }
  });

  it('guarda la clave cifrada y nunca la devuelve', async () => {
    const { user, token } = await seedLoggedIn();

    const guardado = await dispatch('/api/keys', {
      method: 'PUT',
      bearer: token,
      body: { provider: 'openrouter', key: CLAVE, model: 'un-modelo/gratis' },
    });
    expect(guardado.status).toBe(200);
    // Ni siquiera la respuesta al guardar devuelve la clave.
    expect(JSON.stringify(await guardado.json())).not.toContain(CLAVE);

    // En la base de datos no está en claro.
    const fila = await env.DB.prepare(
      'SELECT key_enc, hint, model FROM user_provider_keys WHERE user_id = ? AND provider = ?',
    ).bind(user.id, 'openrouter').first<{ key_enc: string; hint: string; model: string }>();
    expect(fila!.key_enc).not.toContain(CLAVE);
    expect(fila!.hint).toBe('••••7890');
    expect(fila!.model).toBe('un-modelo/gratis');

    // Y la lectura posterior solo enseña la pista.
    const listado = await dispatch('/api/keys', { bearer: token });
    const cuerpo = await listado.text();
    expect(cuerpo).not.toContain(CLAVE);
    expect(cuerpo).toContain('••••7890');
  });

  it('la clave de un usuario no aparece en el listado de otro', async () => {
    const primero = await seedLoggedIn({ email: 'uno@aurum.test' });
    const segundo = await seedLoggedIn({ email: 'dos@aurum.test' });

    await dispatch('/api/keys', {
      method: 'PUT',
      bearer: primero.token,
      body: { provider: 'grok', key: CLAVE },
    });

    const res = await dispatch('/api/keys', { bearer: segundo.token });
    const providers = (await res.json<{ providers: { id: string; hasOwnKey: boolean }[] }>()).providers;
    expect(providers.find(p => p.id === 'grok')!.hasOwnKey).toBe(false);
  });

  it('permite cambiar solo el modelo sin volver a pegar la clave', async () => {
    const { user, token } = await seedLoggedIn();
    await dispatch('/api/keys', { method: 'PUT', bearer: token, body: { provider: 'grok', key: CLAVE } });

    const soloModelo = await dispatch('/api/keys', {
      method: 'PUT', bearer: token, body: { provider: 'grok', model: 'grok-4.6' },
    });
    expect(soloModelo.status).toBe(200);

    // La clave sigue siendo la misma y ahora hay modelo.
    const fila = await env.DB.prepare(
      'SELECT hint, model FROM user_provider_keys WHERE user_id = ? AND provider = ?',
    ).bind(user.id, 'grok').first<{ hint: string; model: string }>();
    expect(fila!.hint).toBe('••••7890');
    expect(fila!.model).toBe('grok-4.6');
  });

  it('sin clave guardada, mandar solo el modelo no crea nada', async () => {
    const { token } = await seedLoggedIn();
    const res = await dispatch('/api/keys', {
      method: 'PUT', bearer: token, body: { provider: 'gemini', model: 'algo' },
    });
    expect(res.status).toBe(404);
  });

  it('rechaza proveedores desconocidos y claves vacías', async () => {
    const { token } = await seedLoggedIn();

    const proveedor = await dispatch('/api/keys', {
      method: 'PUT', bearer: token, body: { provider: 'inventado', key: CLAVE },
    });
    expect(proveedor.status).toBe(400);

    const vacia = await dispatch('/api/keys', {
      method: 'PUT', bearer: token, body: { provider: 'grok', key: '   ' },
    });
    expect(vacia.status).toBe(400);
  });

  it('borra la clave y el proveedor vuelve a quedar sin configurar', async () => {
    const { token } = await seedLoggedIn();
    await dispatch('/api/keys', { method: 'PUT', bearer: token, body: { provider: 'gemini', key: CLAVE } });

    const borrado = await dispatch('/api/keys?provider=gemini', { method: 'DELETE', bearer: token });
    expect(borrado.status).toBe(200);

    const res = await dispatch('/api/keys', { bearer: token });
    const providers = (await res.json<{ providers: { id: string; hasOwnKey: boolean }[] }>()).providers;
    expect(providers.find(p => p.id === 'gemini')!.hasOwnKey).toBe(false);
  });
});

describe('/api/backend-config', () => {
  const URL_BACKEND = 'https://aurum-backend.tailnet.ts.net';
  const TOKEN = 'token-del-backend-privado-123456';

  it('no responde sin sesión', async () => {
    expect((await dispatch('/api/backend-config')).status).toBe(401);
  });

  it('sin configurar devuelve null, no un error', async () => {
    const { token } = await seedLoggedIn();
    const res = await dispatch('/api/backend-config', { bearer: token });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ config: null });
  });

  it('guarda cifrado y devuelve el token al dueño', async () => {
    const { user, token } = await seedLoggedIn();
    const guardado = await dispatch('/api/backend-config', {
      method: 'PUT', bearer: token, body: { url: URL_BACKEND, token: TOKEN },
    });
    expect(guardado.status).toBe(200);

    // En la base no esta en claro.
    const fila = await env.DB.prepare(
      'SELECT url, token_enc FROM user_backend_config WHERE user_id = ?',
    ).bind(user.id).first<{ url: string; token_enc: string }>();
    expect(fila!.url).toBe(URL_BACKEND);
    expect(fila!.token_enc).not.toContain(TOKEN);

    // Pero al dueño si se le devuelve: es el navegador quien llama al backend.
    const leido = await dispatch('/api/backend-config', { bearer: token });
    expect(await leido.json()).toMatchObject({ config: { url: URL_BACKEND, apiKey: TOKEN } });
  });

  it('la configuración de un usuario no la ve otro', async () => {
    const primero = await seedLoggedIn({ email: 'uno@aurum.test' });
    const segundo = await seedLoggedIn({ email: 'dos@aurum.test' });
    await dispatch('/api/backend-config', {
      method: 'PUT', bearer: primero.token, body: { url: URL_BACKEND, token: TOKEN },
    });
    const res = await dispatch('/api/backend-config', { bearer: segundo.token });
    expect(await res.json()).toMatchObject({ config: null });
  });

  it('rechaza direcciones sin esquema', async () => {
    const { token } = await seedLoggedIn();
    const res = await dispatch('/api/backend-config', {
      method: 'PUT', bearer: token, body: { url: 'aurum-backend.local:8000', token: TOKEN },
    });
    expect(res.status).toBe(400);
  });

  it('se puede borrar', async () => {
    const { token } = await seedLoggedIn();
    await dispatch('/api/backend-config', { method: 'PUT', bearer: token, body: { url: URL_BACKEND, token: TOKEN } });
    expect((await dispatch('/api/backend-config', { method: 'DELETE', bearer: token })).status).toBe(200);
    const res = await dispatch('/api/backend-config', { bearer: token });
    expect(await res.json()).toMatchObject({ config: null });
  });
});

describe('eleccion automatica de modelo', () => {
  const catalogo = [
    { id: 'caro/grande',   nombre: 'caro',   entrada: 10, salida: 30,  contexto: 200_000, gratuito: false },
    { id: 'gratis/corto',  nombre: 'corto',  entrada: 0,  salida: 0,   contexto: 8_000,   gratuito: true  },
    { id: 'gratis/amplio', nombre: 'amplio', entrada: 0,  salida: 0,   contexto: 128_000, gratuito: true  },
    { id: 'sin-precio',    nombre: 'opaco',  entrada: null, salida: null, contexto: 500_000, gratuito: false },
  ];

  it('elige el mas barato con contexto suficiente', () => {
    expect(elegirAutomatico(catalogo)!.id).toBe('gratis/amplio');
  });

  it('descarta los que no llegan al contexto minimo aunque sean gratis', () => {
    const soloCorto = catalogo.filter(m => m.id !== 'gratis/amplio');
    expect(elegirAutomatico(soloCorto)!.id).toBe('caro/grande');
  });

  it('sin precios publicados elige igualmente, en vez de dejar el proveedor inservible', () => {
    // Antes se rendía aquí, por no adivinar. La consecuencia fue peor que el
    // problema: el catálogo de OpenAI, Gemini, Grok y DeepSeek no publica
    // precios, así que «auto» respondía 503 en cuatro de los cinco proveedores.
    // Elegir por el nombre no es exacto, pero se actualiza con el catálogo y
    // deja la aplicación funcionando.
    expect(elegirAutomatico([catalogo[3]])?.id).toBe(catalogo[3].id);
  });

  it('sin catalogo no elige nada', () => {
    expect(elegirAutomatico([])).toBeNull();
  });
});

describe('a quién restringe la allowlist', () => {
  function peticion(body: unknown): Request {
    return new Request('https://aurum.test/api/anthropic', { method: 'POST', body: JSON.stringify(body) });
  }

  it('con la clave del proyecto se limita a la lista', async () => {
    const credenciales: Credentials = { key: 'k', source: 'project', model: null };
    const res = await validateBody(peticion({ model: 'un-modelo-carisimo' }), 'anthropic', credenciales);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
  });

  it('con la clave del usuario manda el usuario, porque paga él', async () => {
    const credenciales: Credentials = { key: 'k', source: 'user', model: null };
    const res = await validateBody(peticion({ model: 'un-modelo-carisimo' }), 'anthropic', credenciales);
    expect(res).not.toBeInstanceOf(Response);
    expect((res as { model: string }).model).toBe('un-modelo-carisimo');
  });

  it('el modelo guardado en Ajustes se impone al que pida el cliente', async () => {
    const credenciales: Credentials = { key: 'k', source: 'user', model: 'el-mio/gratis' };
    const res = await validateBody(peticion({ model: 'otro-cualquiera' }), 'openrouter', credenciales);
    expect((res as { model: string }).model).toBe('el-mio/gratis');
  });

  it('el tope de tokens se aplica también con la clave del usuario', async () => {
    const credenciales: Credentials = { key: 'k', source: 'user', model: null };
    const res = await validateBody(
      peticion({ model: 'lo-que-sea', max_tokens: 500_000 }),
      'openrouter',
      credenciales,
    );
    expect((res as { body: Record<string, unknown> }).body.max_tokens).toBe(8192);
  });

  it('sin modelo elegido, la clave queda en automatico y no inservible', async () => {
    // Antes se guardaba sin modelo y esa ruta devolvia 503 para siempre: el
    // usuario creia haberla configurado y estaba usando el respaldo sin saberlo.
    // Ahora queda en automatico, que elige del catalogo; aqui no hay catalogo
    // que consultar, de ahi el 503 distinto — pero ya no es un callejon.
    const { token } = await seedLoggedIn();
    await dispatch('/api/keys', { method: 'PUT', bearer: token, body: { provider: 'grok', key: 'sk-sin-modelo' } });

    const res = await dispatch('/api/grok', {
      method: 'POST', bearer: token, body: { model: 'lo-que-sea', messages: [] },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'auto_unavailable' } });
  });

  it('los proveedores con clave del usuario no llevan allowlist', () => {
    expect(PROVIDERS.gemini.allowed).toBeUndefined();
    expect(PROVIDERS.grok.allowed).toBeUndefined();
    expect(PROVIDERS.openrouter.allowed).toBeUndefined();
  });
});

describe('una clave guardada sin modelo', () => {
  it('queda en automático en vez de quedarse inservible', async () => {
    // Sin modelo, esa ruta responde 503 y entra el respaldo: el usuario cree
    // haber configurado el proveedor y no lo está usando. Lo vimos con Gemini.
    const { token } = await seedLoggedIn();

    const res = await dispatch('/api/keys', {
      method: 'PUT', bearer: token,
      body: JSON.stringify({ provider: 'gemini', key: CLAVE }),
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ model: string }>()).model).toBe(MODELO_AUTOMATICO);
  });

  it('un modelo elegido a mano no se pisa', async () => {
    const { token } = await seedLoggedIn();

    const res = await dispatch('/api/keys', {
      method: 'PUT', bearer: token,
      body: JSON.stringify({ provider: 'gemini', key: CLAVE, model: 'gemini-3-pro' }),
    });
    expect((await res.json<{ model: string }>()).model).toBe('gemini-3-pro');
  });
});

describe('el modo automático sin precios publicados', () => {
  const m = (id: string, salida: number|null = null, contexto: number|null = null) =>
    ({ id, salida, contexto, gratuito: false } as never);

  it('con precios elige el más barato con contexto suficiente', () => {
    const elegido = elegirAutomatico([
      m('caro', 10, 128_000), m('barato', 1, 128_000), m('barato-sin-contexto', 0.5, 8_000),
    ]);
    expect(elegido?.id).toBe('barato');
  });

  it('sin precios elige la gama barata por su nombre', () => {
    // El catálogo de OpenAI no publica precios ni contexto: solo identificadores.
    // Antes esto devolvía null y la ruta respondía 503 para siempre.
    const elegido = elegirAutomatico([m('gpt-5'), m('gpt-5-mini'), m('gpt-5-pro')]);
    expect(elegido?.id).toBe('gpt-5-mini');
  });

  it('prefiere el alias estable a la versión con fecha', () => {
    const elegido = elegirAutomatico([m('gpt-5-mini-2026-03-11-preview'), m('gpt-5-mini')]);
    expect(elegido?.id).toBe('gpt-5-mini');
  });

  it('descarta la gama nano aunque sea la más barata', () => {
    // gpt-5-nano es de razonamiento: con el presupuesto de una conversación se
    // lo gasta pensando y devuelve texto vacío. Salía «Sin respuesta.», que es
    // peor que un error porque no dice qué hacer.
    expect(elegirAutomatico([m('gpt-5-mini'), m('gpt-5-nano')])?.id).toBe('gpt-5-mini');
    expect(elegirAutomatico([m('gpt-5-nano')])).toBeNull();
  });

  it('no elige cosas que no sirven para conversar', () => {
    const elegido = elegirAutomatico([
      m('text-embedding-3-small'), m('whisper-1'), m('dall-e-3'), m('gpt-5'),
    ]);
    expect(elegido?.id).toBe('gpt-5');
  });

  it('sin gama reconocible contesta con algo antes que fallar', () => {
    expect(elegirAutomatico([m('deepseek-chat'), m('deepseek-reasoner')])?.id).toBe('deepseek-chat');
  });

  it('si no hay nada conversacional sí se rinde', () => {
    expect(elegirAutomatico([m('text-embedding-3-small'), m('whisper-1')])).toBeNull();
    expect(elegirAutomatico([])).toBeNull();
  });
});
