/**
 * Primitivas criptográficas.
 *
 * Aquí se comprueban las propiedades de las que depende todo lo demás: que un
 * hash no se pueda dar por bueno con otra contraseña, que un payload firmado no
 * se pueda manipular ni reutilizar pasada su caducidad, y que subir el coste de
 * PBKDF2 no invalide las cuentas ya creadas.
 */

import { describe, expect, it } from 'vitest';
import {
  PBKDF2_ITERATIONS,
  fromBase64Url,
  hashPassword,
  hashToken,
  hmacSign,
  hmacVerify,
  needsRehash,
  pkceChallenge,
  pkceVerifier,
  randomInviteCode,
  randomToken,
  signPayload,
  timingSafeEqual,
  toBase64Url,
  verifyPassword,
  verifyPayload,
} from '../../functions/_lib/crypto.ts';

const SECRET = 'secreto-de-prueba';

describe('base64url', () => {
  it('va y vuelve sin perder bytes', () => {
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
  });

  it('no emite relleno ni caracteres que haya que escapar en una URL', () => {
    for (let len = 1; len <= 8; len++) {
      const encoded = toBase64Url(crypto.getRandomValues(new Uint8Array(len)));
      expect(encoded).not.toMatch(/[+/=]/);
    }
  });
});

describe('aleatoriedad', () => {
  it('randomToken devuelve 32 bytes distintos cada vez', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => randomToken()));
    expect(tokens.size).toBe(50);
    expect(fromBase64Url([...tokens][0]).length).toBe(32);
  });

  it('el código de invitación se puede dictar sin ambigüedad', () => {
    for (let i = 0; i < 20; i++) {
      const code = randomInviteCode();
      expect(code).toMatch(/^[2-9BCDFGHJKMNPQRSTVWXYZ]{5}(-[2-9BCDFGHJKMNPQRSTVWXYZ]{5}){3}$/);
      // Sin vocales (no se forman palabras) ni caracteres que se confundan.
      expect(code).not.toMatch(/[AEIOU01ILO]/);
    }
  });
});

describe('timingSafeEqual', () => {
  it('distingue contenido y longitud', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

describe('hashToken', () => {
  it('es determinista y devuelve SHA-256 en hex', async () => {
    const hash = await hashToken('token-de-sesion');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashToken('token-de-sesion')).toBe(hash);
    expect(await hashToken('token-de-sesiOn')).not.toBe(hash);
  });
});

describe('contraseñas', () => {
  it('el hash lleva sus parámetros y una sal distinta cada vez', async () => {
    const a = await hashPassword('contraseña-larguisima');
    const b = await hashPassword('contraseña-larguisima');
    expect(a).not.toBe(b);
    const [scheme, hash, iterations] = a.split('$');
    expect(scheme).toBe('pbkdf2');
    expect(hash).toBe('sha256');
    expect(Number(iterations)).toBe(PBKDF2_ITERATIONS);
  });

  it('acepta la contraseña correcta y rechaza cualquier otra', async () => {
    const stored = await hashPassword('contraseña-larguisima');
    expect(await verifyPassword('contraseña-larguisima', stored)).toBe(true);
    expect(await verifyPassword('contraseña-larguisim', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('una cuenta sin contraseña (solo Google) nunca valida', async () => {
    expect(await verifyPassword('lo-que-sea', null)).toBe(false);
  });

  it('rechaza hashes con formato o coste que no sean los esperados', async () => {
    expect(await verifyPassword('x', 'md5$sha256$100000$c2FsdA$aGFzaA')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$sha1$100000$c2FsdA$aGFzaA')).toBe(false);
    // Coste absurdamente bajo: se rechaza en lugar de verificarlo.
    expect(await verifyPassword('x', 'pbkdf2$sha256$10$c2FsdA$aGFzaA')).toBe(false);
    expect(await verifyPassword('x', 'basura')).toBe(false);
  });

  it('needsRehash solo marca los hashes por debajo del coste actual', async () => {
    expect(needsRehash(await hashPassword('contraseña-larguisima'))).toBe(false);
    expect(needsRehash(`pbkdf2$sha256$${PBKDF2_ITERATIONS - 1}$c2FsdA$aGFzaA`)).toBe(true);
    expect(needsRehash('basura')).toBe(true);
    // Una cuenta sin contraseña no tiene nada que regenerar.
    expect(needsRehash(null)).toBe(false);
  });

  it('un hash con menos iteraciones sigue validando, para poder subir el coste', async () => {
    // Simula un hash antiguo: mismo algoritmo, coste inferior al actual.
    const legacy = 'pbkdf2$sha256$1000$';
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('clave-antigua'), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 1000 }, key, 256);
    const stored = legacy + toBase64Url(salt) + '$' + toBase64Url(new Uint8Array(bits));

    expect(await verifyPassword('clave-antigua', stored)).toBe(true);
    expect(needsRehash(stored)).toBe(true);
  });
});

describe('HMAC y payloads firmados', () => {
  it('la firma solo verifica con el mismo secreto y los mismos datos', async () => {
    const sig = await hmacSign(SECRET, 'datos');
    expect(await hmacVerify(SECRET, 'datos', sig)).toBe(true);
    expect(await hmacVerify(SECRET, 'datos!', sig)).toBe(false);
    expect(await hmacVerify('otro-secreto', 'datos', sig)).toBe(false);
  });

  it('un payload firmado se recupera intacto', async () => {
    const token = await signPayload(SECRET, { nonce: 'n', verifier: 'v', invite: null, native: true }, 60_000);
    expect(await verifyPayload(SECRET, token)).toEqual({ nonce: 'n', verifier: 'v', invite: null, native: true });
  });

  it('rechaza un payload manipulado, mal firmado o caducado', async () => {
    const token = await signPayload(SECRET, { admin: false }, 60_000);
    const [body, exp, sig] = token.split('.');

    // Cuerpo cambiado, firma original.
    const forgedBody = toBase64Url(new TextEncoder().encode(JSON.stringify({ admin: true })));
    expect(await verifyPayload(SECRET, `${forgedBody}.${exp}.${sig}`)).toBeNull();

    // Caducidad estirada.
    expect(await verifyPayload(SECRET, `${body}.${Number(exp) + 600_000}.${sig}`)).toBeNull();

    // Otro secreto.
    expect(await verifyPayload('secreto-ajeno', token)).toBeNull();

    // Formato incompleto.
    expect(await verifyPayload(SECRET, 'solo-una-parte')).toBeNull();

    // Ya caducado en el momento de firmarlo.
    expect(await verifyPayload(SECRET, await signPayload(SECRET, { a: 1 }, -1_000))).toBeNull();
  });
});

describe('PKCE', () => {
  it('el challenge es el SHA-256 del verificador en base64url', async () => {
    const verifier = pkceVerifier();
    const challenge = await pkceChallenge(verifier);
    const expected = toBase64Url(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    );
    expect(challenge).toBe(expected);
    expect(challenge).not.toMatch(/[+/=]/);
    expect(await pkceChallenge(pkceVerifier())).not.toBe(challenge);
  });
});
