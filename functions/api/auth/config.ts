/**
 * GET /api/auth/config — información pública de la pantalla de acceso.
 *
 * Solo dice qué vías de acceso están disponibles y si la instalación todavía no
 * tiene ningún usuario. No expone nada que no se deduzca ya del formulario.
 */

import type { PagesContext } from '../../_lib/types.ts';
import { json } from '../../_lib/http.ts';
import { countUsers } from '../../_lib/auth.ts';

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { env } = context;
  const users = await countUsers(env);
  return json({
    googleEnabled: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    passwordEnabled: true,
    // Si no hay ningún usuario, la pantalla ofrece crear el owner inicial.
    needsBootstrap: users === 0,
    // El registro nunca es abierto: siempre invitación (o bootstrap).
    openRegistration: false,
  });
}
