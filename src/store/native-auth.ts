/**
 * Acceso con Google desde la APK.
 *
 * Google rechaza el flujo de OAuth dentro de un webview embebido
 * (`disallowed_useragent`), así que la aplicación abre el navegador del sistema
 * y espera a que el usuario vuelva por el deep link `aurum://auth`.
 *
 * Lo que llega por el deep link no es la sesión, sino un código de un solo uso:
 * en Android cualquier aplicación puede registrar el mismo esquema y recibir
 * esa URL, de modo que un token de sesión ahí sería un regalo. El código se
 * canjea en /api/auth/exchange y solo entonces existe la sesión.
 */

import { API_BASE, apiFetch, isNative, setNativeToken } from './api';
import type { SessionUser } from './session';

const DEEP_LINK_PREFIX = 'aurum://auth';

interface ExchangePayload {
  user: SessionUser;
  expiresAt: number;
  token?: string;
}

/** Abre el acceso con Google fuera del webview. */
export async function startGoogleLogin(invite?: string): Promise<void> {
  const params = new URLSearchParams({ client: 'native' });
  if (invite?.trim()) params.set('invite', invite.trim().toUpperCase());
  const url = `${API_BASE}/api/auth/google/start?${params.toString()}`;

  const { Browser } = await import('@capacitor/browser');
  await Browser.open({ url, presentationStyle: 'popover' });
}

/** Canjea el código del deep link por una sesión. */
export async function exchangeCode(code: string): Promise<SessionUser> {
  const payload = await apiFetch<ExchangePayload>('/api/auth/exchange', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  if (payload.token) setNativeToken(payload.token);
  return payload.user;
}

/**
 * Registra el manejador del deep link. Devuelve una función para quitarlo.
 * Fuera de la APK no hace nada, así que es seguro llamarla siempre.
 */
export function listenForDeepLink(handlers: {
  onSession: (user: SessionUser) => void;
  onError: (reason: string) => void;
}): () => void {
  if (!isNative) return () => {};

  let removeListener: (() => void) | null = null;
  let cancelled = false;

  void (async () => {
    const { App } = await import('@capacitor/app');
    const handle = await App.addListener('appUrlOpen', ({ url }) => {
      if (!url.startsWith(DEEP_LINK_PREFIX)) return;

      // El navegador del sistema se cierra en cuanto la app recupera el foco.
      void import('@capacitor/browser').then(({ Browser }) => Browser.close().catch(() => {}));

      const params = new URL(url).searchParams;
      const code = params.get('code');
      if (params.get('auth') !== 'ok' || !code) {
        handlers.onError(params.get('reason') ?? 'unknown');
        return;
      }

      exchangeCode(code)
        .then(handlers.onSession)
        .catch(() => handlers.onError('exchange_failed'));
    });

    if (cancelled) {
      await handle.remove();
      return;
    }
    removeListener = () => void handle.remove();
  })();

  return () => {
    cancelled = true;
    removeListener?.();
  };
}
