/**
 * GET /api/apk — descarga de la aplicación para Android.
 *
 * La APK vive como fichero estático, pero su ruta la corta `functions/descargas`
 * para que no se pueda pedir directamente: aquí se sirve solo a quien tiene
 * sesión, igual que el resto de la aplicación. `env.ASSETS.fetch` va al almacén
 * de estáticos sin pasar por las funciones, así que sí la encuentra.
 *
 * Hace falta porque la APK es una carcasa que carga el sitio: los cambios de la
 * web llegan solos al recargar, y solo se reparte una nueva cuando cambia algo
 * nativo. Sin esto, actualizarla obliga a enchufar el móvil por cable.
 */

import type { PagesContext } from '../_lib/types.ts';
import { fail } from '../_lib/http.ts';

/** Ruta interna del fichero. No es alcanzable desde fuera. */
const RUTA_APK = '/descargas/aurum.apk';

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { request, env, data } = context;
  if (!data.user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  const origen = new URL(RUTA_APK, request.url);
  const respuesta = await env.ASSETS.fetch(new Request(origen.toString(), { method: 'GET' }));

  if (!respuesta.ok) {
    return fail(404, 'not_found', 'Todavía no hay ninguna versión publicada.');
  }

  // Se reenvía el cuerpo tal cual, con el nombre con el que debe guardarse.
  return new Response(respuesta.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="aurum.apk"',
      // Privada: la respuesta depende de tener sesión, así que ninguna caché
      // intermedia debe servírsela a quien no ha pasado por aquí.
      'Cache-Control': 'private, max-age=300',
    },
  });
}
