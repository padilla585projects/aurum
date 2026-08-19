/**
 * Utilidades HTTP.
 *
 * El punto que más importa aquí es el CORS: la versión anterior de AURUM
 * respondía `Access-Control-Allow-Origin: *` y cualquier página podía gastar las
 * claves de IA del proyecto. Estas pruebas fijan que nunca se vuelva a emitir un
 * comodín y que la allowlist se compare de forma exacta.
 */

import { describe, expect, it } from 'vitest';
import type { Env } from '../../functions/_lib/types.ts';
import {
  allowedOrigins,
  bearerToken,
  clearSessionCookie,
  clientIp,
  corsHeaders,
  fail,
  isAllowedOrigin,
  isNativeOrigin,
  json,
  normalizeEmail,
  readCookie,
  readJson,
  sessionCookie,
  userAgent,
  validatePassword,
} from '../../functions/_lib/http.ts';

const env = {
  AURUM_ALLOWED_ORIGINS: ' https://aurum.test , https://otra.aurum.test/ ,,',
} as Env;

function req(headers: Record<string, string> = {}, init: RequestInit = {}): Request {
  return new Request('https://aurum.test/api/x', { headers, ...init });
}

describe('orígenes', () => {
  it('descarta espacios, barras finales y entradas vacías', () => {
    expect(allowedOrigins(env)).toEqual(['https://aurum.test', 'https://otra.aurum.test']);
  });

  it('compara el origen completo, no por prefijo', () => {
    expect(isAllowedOrigin(env, 'https://aurum.test')).toBe(true);
    expect(isAllowedOrigin(env, 'https://aurum.test/')).toBe(true);
    expect(isAllowedOrigin(env, 'https://aurum.test.evil.com')).toBe(false);
    expect(isAllowedOrigin(env, 'http://aurum.test')).toBe(false);
    expect(isAllowedOrigin(env, null)).toBe(false);
    expect(isAllowedOrigin({} as Env, 'https://aurum.test')).toBe(false);
  });

  it('reconoce los orígenes de la aplicación nativa', () => {
    expect(isNativeOrigin('capacitor://localhost')).toBe(true);
    expect(isNativeOrigin('http://localhost')).toBe(true);
    expect(isNativeOrigin('ionic://localhost')).toBe(true);
    expect(isNativeOrigin('https://localhost')).toBe(false);
    expect(isNativeOrigin(null)).toBe(false);
  });

  it('nunca devuelve un comodín y siempre marca Vary', () => {
    const permitido = corsHeaders(env, req({ Origin: 'https://aurum.test' }));
    expect(permitido['Access-Control-Allow-Origin']).toBe('https://aurum.test');
    expect(permitido['Access-Control-Allow-Credentials']).toBe('true');
    expect(permitido.Vary).toBe('Origin');

    const ajeno = corsHeaders(env, req({ Origin: 'https://evil.test' }));
    expect(ajeno['Access-Control-Allow-Origin']).toBeUndefined();
    expect(Object.values(ajeno)).not.toContain('*');

    expect(corsHeaders(env, req())['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('respuestas', () => {
  it('json marca no-store y nosniff', async () => {
    const res = json({ a: 1 });
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('fail devuelve código y mensaje bajo la misma forma', async () => {
    const res = fail(429, 'rate_limited', 'Demasiadas peticiones.', { 'Retry-After': '60' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(await res.json()).toEqual({ error: { code: 'rate_limited', message: 'Demasiadas peticiones.' } });
  });
});

describe('cookies', () => {
  it('lee la cookie que toca entre varias', () => {
    const request = req({ Cookie: 'otra=1; aurum_session=abc%2Fdef; tercera=3' });
    expect(readCookie(request, 'aurum_session')).toBe('abc/def');
    expect(readCookie(request, 'no_existe')).toBeNull();
    expect(readCookie(req(), 'aurum_session')).toBeNull();
  });

  it('la cookie de sesión sale con todos los atributos de protección', () => {
    const cookie = sessionCookie('t/oken', 3600);
    expect(cookie).toContain('aurum_session=t%2Foken');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=3600');
  });

  it('el cierre de sesión caduca la cookie de inmediato', () => {
    expect(clearSessionCookie()).toContain('Max-Age=0');
    expect(clearSessionCookie()).toContain('HttpOnly');
  });
});

describe('credencial entrante', () => {
  it('la cabecera Authorization tiene prioridad sobre la cookie', () => {
    expect(bearerToken(req({ Authorization: 'Bearer nativo', Cookie: 'aurum_session=web' }))).toBe('nativo');
    expect(bearerToken(req({ Cookie: 'aurum_session=web' }))).toBe('web');
    expect(bearerToken(req({ Authorization: 'Basic loquesea' }))).toBeNull();
    expect(bearerToken(req({ Authorization: 'Bearer   ' }))).toBeNull();
    expect(bearerToken(req())).toBeNull();
  });
});

describe('cliente', () => {
  it('prefiere CF-Connecting-IP y si no toma la primera de X-Forwarded-For', () => {
    expect(clientIp(req({ 'CF-Connecting-IP': '203.0.113.1', 'X-Forwarded-For': '198.51.100.9' }))).toBe('203.0.113.1');
    expect(clientIp(req({ 'X-Forwarded-For': '198.51.100.9, 10.0.0.1' }))).toBe('198.51.100.9');
    expect(clientIp(req())).toBe('unknown');
  });

  it('recorta el user agent para que no llene la tabla de sesiones', () => {
    expect(userAgent(req({ 'User-Agent': 'x'.repeat(500) })).length).toBe(255);
    expect(userAgent(req())).toBe('');
  });
});

describe('entrada', () => {
  it('lee JSON válido y rechaza lo que no lo es', async () => {
    const ok = req({ 'Content-Type': 'application/json' }, { method: 'POST', body: '{"a":1}' });
    expect(await readJson(ok)).toEqual({ a: 1 });

    const roto = req({}, { method: 'POST', body: 'no soy json' });
    expect(await readJson(roto)).toBeNull();
  });

  it('rechaza cuerpos que superan el límite, con y sin Content-Length honesto', async () => {
    const grande = req({ 'Content-Length': '999999' }, { method: 'POST', body: '{}' });
    expect(await readJson(grande, 1024)).toBeNull();

    const largo = req({}, { method: 'POST', body: JSON.stringify({ x: 'y'.repeat(2048) }) });
    expect(await readJson(largo, 1024)).toBeNull();
  });

  it('normaliza el correo y rechaza los que no lo parecen', () => {
    expect(normalizeEmail('  Adrian@AURUM.test ')).toBe('adrian@aurum.test');
    expect(normalizeEmail('sin-arroba')).toBeNull();
    expect(normalizeEmail('a@b')).toBeNull();
    expect(normalizeEmail('a b@c.test')).toBeNull();
    expect(normalizeEmail(`${'a'.repeat(250)}@b.test`)).toBeNull();
    expect(normalizeEmail(42)).toBeNull();
    expect(normalizeEmail(null)).toBeNull();
  });

  it('exige doce caracteres de contraseña', () => {
    expect(validatePassword('doce-caracte')).toEqual({ ok: true, value: 'doce-caracte' });
    expect(validatePassword('corta')).toMatchObject({ ok: false });
    expect(validatePassword('x'.repeat(257))).toMatchObject({ ok: false });
    expect(validatePassword(undefined)).toMatchObject({ ok: false });
  });
});
