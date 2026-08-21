/**
 * Corta el acceso directo a los ficheros de /descargas.
 *
 * La APK tiene que estar como fichero estático para que `env.ASSETS` la
 * encuentre, pero eso la dejaría colgando en una dirección pública. Esta
 * función se pone delante de esa ruta y responde 404 a cualquiera: la única
 * puerta es /api/apk, que exige sesión.
 *
 * `env.ASSETS.fetch` no pasa por aquí —va al almacén de estáticos directamente—
 * así que la descarga legítima sigue funcionando.
 */

export function onRequest(): Response {
  return new Response('Not Found', { status: 404 });
}
