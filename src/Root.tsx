/**
 * Raíz de la aplicación: decide entre la pantalla de acceso y AURUM.
 *
 * Responsabilidades:
 *   1. Resolver la sesión actual contra /api/auth/me.
 *   2. Cargar el estado del usuario antes de montar la aplicación, para que los
 *      módulos que leen de forma síncrona encuentren los datos ya disponibles.
 *   3. Traducir el resultado del retorno de Google a un mensaje entendible.
 *   4. Mantener el estado sincronizado al recuperar el foco y al salir.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import App from './App';
import Login from './components/Login';
import { C } from './theme';
import { fetchAuthConfig, fetchMe, logout, type AuthConfig, type SessionUser } from './store/session';
import { SessionContext } from './store/session-context';
import { listenForDeepLink } from './store/native-auth';
import * as store from './store/state';

/** Motivos que puede devolver /api/auth/google/callback. */
const OAUTH_ERRORS: Record<string, string> = {
  cancelled: 'Has cancelado el acceso con Google.',
  bad_state: 'La sesión de acceso caducó. Inténtalo otra vez.',
  exchange_failed: 'Google no ha validado el acceso. Inténtalo otra vez.',
  no_claims: 'Google no ha devuelto un correo con el que identificarte.',
  email_unverified: 'Google no confirma que ese correo sea tuyo, así que no se puede vincular con una cuenta existente.',
  invite_required: 'Necesitas una invitación para crear una cuenta.',
  invite_invalid: 'La invitación no es válida o ya se ha usado.',
  invite_used: 'Esa invitación acaba de usarse.',
  suspended: 'Esta cuenta está suspendida.',
  google_disabled: 'El acceso con Google no está activado en este despliegue.',
  unknown_user: 'No se ha encontrado la cuenta asociada.',
};

type Phase =
  | { kind: 'loading' }
  | { kind: 'anon'; config: AuthConfig; error: string | null }
  | { kind: 'ready'; user: SessionUser; offline: boolean }
  | { kind: 'error'; message: string };

export default function Root() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });

  /** Lee y limpia los parámetros que deja el retorno de Google. */
  const oauthError = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    const auth = params.get('auth');
    if (!auth) return null;
    const reason = params.get('reason');
    params.delete('auth');
    params.delete('reason');
    params.delete('rid');
    const query = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''));
    if (auth === 'ok') return null;
    return OAUTH_ERRORS[reason ?? ''] ?? 'No se ha podido completar el acceso con Google.';
  }, []);

  const enter = useCallback(async (user: SessionUser) => {
    const { online } = await store.hydrate(user.id);
    setPhase({ kind: 'ready', user, offline: !online });
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await fetchMe();
        if (cancelled) return;
        if (user) {
          await enter(user);
          return;
        }
        const config = await fetchAuthConfig();
        if (!cancelled) setPhase({ kind: 'anon', config, error: oauthError });
      } catch {
        if (!cancelled) {
          setPhase({
            kind: 'error',
            message: 'No se ha podido contactar con el servidor de AURUM.',
          });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [enter, oauthError]);

  // Retorno del acceso con Google en la APK. Se escucha siempre que no haya
  // sesión: el usuario puede volver del navegador en cualquier momento.
  useEffect(() => {
    if (phase.kind === 'ready') return;
    return listenForDeepLink({
      onSession: user => void enter(user),
      onError: reason =>
        setPhase(current =>
          current.kind === 'anon'
            ? { ...current, error: OAUTH_ERRORS[reason] ?? 'No se ha podido completar el acceso con Google.' }
            : current,
        ),
    });
  }, [phase.kind, enter]);

  // Sincronización oportunista: al volver a la pestaña y antes de cerrarla.
  useEffect(() => {
    if (phase.kind !== 'ready') return;
    const onFocus = () => { void store.refresh(); };
    const onHide = () => { void store.flush(); };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', onHide);
    };
  }, [phase.kind]);

  const signOut = useCallback(async (everywhere = false) => {
    await store.flush().catch(() => {
      // Si no se puede guardar, se cierra igualmente: los cambios siguen en el
      // espejo local y se enviarán al volver a entrar.
    });
    await logout(everywhere);
    store.detach();
    const config = await fetchAuthConfig().catch(() => null);
    setPhase(
      config
        ? { kind: 'anon', config, error: null }
        : { kind: 'error', message: 'Sesión cerrada, pero el servidor no responde.' },
    );
  }, []);

  if (phase.kind === 'loading') return <Splash text="Cargando AURUM…" />;
  if (phase.kind === 'error') return <Splash text={phase.message} tone="error" />;

  if (phase.kind === 'anon') {
    return <Login config={phase.config} initialError={phase.error} onAuthenticated={u => void enter(u)} />;
  }

  return (
    <SessionContext.Provider value={{ user: phase.user, offline: phase.offline, signOut }}>
      <App />
    </SessionContext.Provider>
  );
}

function Splash({ text, tone = 'normal' }: { text: string; tone?: 'normal' | 'error' }) {
  return (
    <div style={{
      minHeight: '100vh',
      background: C.bg,
      color: tone === 'error' ? C.red : C.muted,
      fontFamily: "'Sora',sans-serif",
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 14,
      padding: 24,
      textAlign: 'center',
    }}>
      <div style={{
        fontFamily: "'Cormorant Garamond',serif",
        fontSize: '2.2em',
        color: C.gold,
        letterSpacing: '.18em',
      }}>
        AURUM
      </div>
      <div style={{ fontSize: '.8em' }}>{text}</div>
    </div>
  );
}
