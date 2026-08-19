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
import { PROVIDERS, validateBody, type Credentials } from '../../functions/_lib/ai-proxy.ts';
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

  it('los proveedores con clave del usuario no llevan allowlist', () => {
    expect(PROVIDERS.gemini.allowed).toBeUndefined();
    expect(PROVIDERS.grok.allowed).toBeUndefined();
    expect(PROVIDERS.openrouter.allowed).toBeUndefined();
  });
});
