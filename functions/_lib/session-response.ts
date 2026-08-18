/**
 * Respuesta común a un inicio de sesión correcto.
 *
 * En la web el token viaja solo en una cookie httpOnly, de modo que un XSS no
 * puede leerlo. La APK de Capacitor no puede depender de cookies, así que pide
 * el token en el cuerpo declarándose con la cabecera `X-AURUM-Client: native`;
 * es el único caso en el que el token se devuelve al cliente.
 */

import type { SessionUser } from './types.ts';
import { json, sessionCookie } from './http.ts';
import { SESSION_TTL_SECONDS } from './auth.ts';

export function isNativeClient(request: Request): boolean {
  return request.headers.get('X-AURUM-Client') === 'native';
}

export function loginResponse(
  request: Request,
  user: SessionUser,
  token: string,
  expiresAt: number,
): Response {
  return json(
    {
      user,
      expiresAt,
      ...(isNativeClient(request) ? { token } : {}),
    },
    { status: 200 },
    { 'Set-Cookie': sessionCookie(token, SESSION_TTL_SECONDS) },
  );
}
