/**
 * GET /api/auth/me — usuario de la sesión actual.
 *
 * Es la llamada con la que el frontend decide si muestra la aplicación o la
 * pantalla de acceso.
 */

import type { PagesContext } from '../../_lib/types.ts';
import { fail, json } from '../../_lib/http.ts';

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const user = context.data.user;
  if (!user) return fail(401, 'unauthenticated', 'No hay sesión activa.');
  return json({ user });
}
