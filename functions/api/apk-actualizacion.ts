/**
 * GET /api/apk-actualizacion — qué versión hay publicada, y por dónde bajarla.
 *
 * La aplicación del móvil compara lo que devuelve esto con la versión que
 * lleva instalada. Sin este dato, avisar de una actualización sería adivinar, y
 * la alternativa era enterarse por el cable.
 *
 * El enlace lleva un vale firmado y de vida corta porque instalar en Android
 * necesita que la descarga la haga el navegador del sistema, y ahí no viaja la
 * sesión de la aplicación.
 */

import type { PagesContext } from '../_lib/types.ts';
import { fail, json } from '../_lib/http.ts';
import { signPayload } from '../_lib/crypto.ts';

/** Lo justo para abrirlo y descargarlo; no para dejarlo circulando. */
const VIDA_DEL_VALE_MS = 5 * 60 * 1000;

interface Publicada {
  versionCode: number;
  versionName: string;
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { request, env, data } = context;
  if (!data.user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  const manifiesto = await env.ASSETS.fetch(
    new Request(new URL('/descargas/version.json', request.url).toString(), { method: 'GET' }),
  );
  if (!manifiesto.ok) {
    return json({ publicada: null });
  }

  let publicada: Publicada;
  try {
    publicada = await manifiesto.json<Publicada>();
  } catch {
    // Manifiesto ilegible: mejor decir que no hay versión que ofrecer una
    // descarga a medias que fallaría más adelante sin explicación.
    return json({ publicada: null });
  }

  const vale = await signPayload(env.AURUM_SIGNING_SECRET, { uso: 'apk' }, VIDA_DEL_VALE_MS);

  return json({
    publicada: {
      versionCode: publicada.versionCode,
      versionName: publicada.versionName,
      url: `/descargas/aurum.apk?t=${encodeURIComponent(vale)}`,
      expiraEn: VIDA_DEL_VALE_MS,
    },
  });
}
