/**
 * Sirve la APK a quien traiga un vale firmado, y a nadie más.
 *
 * La APK tiene que existir como fichero estático para poder servirla, y eso la
 * dejaría colgando en una dirección pública. Esta función se pone delante y
 * exige un vale de un solo uso que emite `/api/apk-actualizacion` tras
 * comprobar la sesión.
 *
 * Existe este camino, además del de `/api/apk`, porque instalar en Android
 * necesita que la descarga la haga el navegador del sistema — y ahí no viaja la
 * sesión de la aplicación. El vale caduca en minutos.
 */

import type { PagesContext } from '../_lib/types.ts';
import { verifyPayload } from '../_lib/crypto.ts';

interface Vale {
  /** Para qué se emitió. Un vale de otra cosa no sirve aquí. */
  uso: string;
}

export async function onRequest(context: PagesContext): Promise<Response> {
  const { request, env } = context;
  const url = new URL(request.url);

  // Un solo manejador y no uno por método: con los dos exportados, cuál gana
  // queda a interpretación, y aquí eso decidiría si la ruta está protegida.
  if (request.method !== 'GET') return new Response('Not Found', { status: 404 });

  // Solo se sirve la APK; cualquier otro fichero de la carpeta no existe.
  if (!url.pathname.endsWith('/aurum.apk')) {
    return new Response('Not Found', { status: 404 });
  }

  const vale = url.searchParams.get('t');
  if (!vale) return new Response('Not Found', { status: 404 });

  const contenido = await verifyPayload<Vale>(env.AURUM_SIGNING_SECRET, vale);
  if (contenido?.uso !== 'apk') {
    // Caducado, manipulado o de otra cosa: se responde igual que si no
    // existiera, para no confirmar siquiera que la ruta es la buena.
    return new Response('Not Found', { status: 404 });
  }

  const fichero = await env.ASSETS.fetch(
    new Request(new URL('/descargas/aurum.apk', request.url).toString(), { method: 'GET' }),
  );
  if (!fichero.ok) return new Response('Not Found', { status: 404 });

  return new Response(fichero.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.android.package-archive',
      'Content-Disposition': 'attachment; filename="aurum.apk"',
      'Cache-Control': 'private, no-store',
    },
  });
}
