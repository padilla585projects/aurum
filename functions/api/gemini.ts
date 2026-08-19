/**
 * Proxy de gemini. Requiere sesión (ver functions/api/_middleware.ts).
 *
 * Toda la lógica —resolución de la clave del usuario o del proyecto,
 * validación del modelo, tope de tokens y registro de consumo— vive en
 * functions/_lib/ai-proxy.ts, compartida por todos los proveedores.
 */

import type { PagesContext } from '../_lib/types.ts';
import { proxyToProvider } from '../_lib/ai-proxy.ts';

export async function onRequestPost(context: PagesContext): Promise<Response> {
  return proxyToProvider(context, 'gemini');
}
