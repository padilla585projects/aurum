/**
 * GET /api/auth/google/start — inicia el acceso con Google.
 *
 * Flujo de código de autorización con PKCE. El verificador y el nonce del state
 * viajan en una cookie httpOnly firmada, no en la URL: así el navegador del
 * usuario es el único que puede completar el intercambio, y un tercero que vea
 * el `state` en los registros de Google no puede reutilizarlo.
 */

import type { PagesContext } from '../../../_lib/types.ts';
import { fail } from '../../../_lib/http.ts';
import { pkceChallenge, pkceVerifier, randomToken, signPayload } from '../../../_lib/crypto.ts';

export const OAUTH_COOKIE = 'aurum_oauth';
const OAUTH_TTL_MS = 10 * 60 * 1000;

export interface OAuthState {
  nonce: string;
  verifier: string;
  invite: string | null;
  /** true si el flujo lo inició la APK y hay que volver por el deep link. */
  native: boolean;
}

export function redirectUri(env: { AURUM_PUBLIC_URL?: string }, request: Request): string {
  const base = (env.AURUM_PUBLIC_URL ?? new URL(request.url).origin).replace(/\/$/, '');
  return `${base}/api/auth/google/callback`;
}

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { request, env } = context;

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    return fail(503, 'google_disabled', 'El acceso con Google no está configurado en este despliegue.');
  }

  const url = new URL(request.url);
  const invite = url.searchParams.get('invite')?.trim().toUpperCase() || null;
  // La APK abre esta URL en el navegador del sistema (Google rechaza el flujo
  // dentro de un webview embebido) y espera volver por aurum://auth.
  const native = url.searchParams.get('client') === 'native';

  const nonce = randomToken(16);
  const verifier = pkceVerifier();
  const state: OAuthState = { nonce, verifier, invite, native };
  const cookieValue = await signPayload(env.AURUM_SIGNING_SECRET, state, OAUTH_TTL_MS);

  const authorize = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorize.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', redirectUri(env, request));
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('scope', 'openid email profile');
  authorize.searchParams.set('state', nonce);
  authorize.searchParams.set('code_challenge', await pkceChallenge(verifier));
  authorize.searchParams.set('code_challenge_method', 'S256');
  // Sin refresh token: AURUM solo usa Google para identificar, no para leer
  // datos del usuario, así que no hay nada que refrescar más tarde.
  authorize.searchParams.set('prompt', 'select_account');

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      'Cache-Control': 'no-store',
      'Set-Cookie': [
        `${OAUTH_COOKIE}=${encodeURIComponent(cookieValue)}`,
        'Path=/api/auth/google',
        'HttpOnly',
        'Secure',
        // Lax (no Strict) para que la cookie sobreviva al retorno desde Google.
        'SameSite=Lax',
        `Max-Age=${OAUTH_TTL_MS / 1000}`,
      ].join('; '),
    },
  });
}
