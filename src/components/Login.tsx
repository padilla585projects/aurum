/**
 * Pantalla de acceso: contraseña y Google.
 *
 * El registro nunca es abierto. La pantalla ofrece tres modos según el estado
 * de la instalación:
 *   · bootstrap — todavía no hay ningún usuario: se crea el propietario con el
 *     secreto de arranque del despliegue.
 *   · login     — acceso normal.
 *   · invite    — alta con código de invitación.
 */

import { useState } from 'react';
import { C } from '../theme';
import { ApiError, isNative } from '../store/api';
import { startGoogleLogin } from '../store/native-auth';
import {
  googleLoginUrl,
  login as doLogin,
  register as doRegister,
  type AuthConfig,
  type SessionUser,
} from '../store/session';

type Mode = 'login' | 'invite' | 'bootstrap';

const input: React.CSSProperties = {
  background: C.surf2,
  border: `1px solid ${C.border2}`,
  borderRadius: 9,
  padding: '11px 13px',
  color: C.text,
  fontSize: '.86em',
  fontFamily: "'Sora',sans-serif",
  outline: 'none',
  width: '100%',
};

const label: React.CSSProperties = {
  fontSize: '.7em',
  color: C.muted,
  marginBottom: 5,
  letterSpacing: '.04em',
  textTransform: 'uppercase',
};

export default function Login({
  config,
  initialError,
  onAuthenticated,
}: {
  config: AuthConfig;
  initialError?: string | null;
  onAuthenticated: (user: SessionUser) => void;
}) {
  const [mode, setMode] = useState<Mode>(config.needsBootstrap ? 'bootstrap' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [invite, setInvite] = useState('');
  const [bootstrapSecret, setBootstrapSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const user =
        mode === 'login'
          ? await doLogin(email, password)
          : await doRegister({
              email,
              password,
              name: name.trim() || undefined,
              ...(mode === 'invite' ? { invite } : { bootstrapSecret }),
            });
      onAuthenticated(user);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : 'No se ha podido completar la operación. Inténtalo de nuevo.',
      );
    } finally {
      setBusy(false);
    }
  };

  const title =
    mode === 'bootstrap' ? 'Crear cuenta de propietario'
    : mode === 'invite' ? 'Activar invitación'
    : 'Acceder';

  return (
    <div style={{
      minHeight: '100vh',
      background: C.bg,
      color: C.text,
      fontFamily: "'Sora',sans-serif",
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{
            fontFamily: "'Cormorant Garamond',serif",
            fontSize: '2.4em',
            fontWeight: 600,
            color: C.gold,
            letterSpacing: '.18em',
          }}>
            AURUM
          </div>
          <div style={{ fontSize: '.72em', color: C.muted, letterSpacing: '.08em' }}>
            Asesor de inversión privado
          </div>
        </div>

        <div style={{
          background: C.surf,
          border: `1px solid ${C.border}`,
          borderRadius: 16,
          padding: 24,
        }}>
          <div style={{
            fontFamily: "'Cormorant Garamond',serif",
            fontSize: '1.25em',
            color: C.goldL,
            marginBottom: 18,
          }}>
            {title}
          </div>

          {mode === 'bootstrap' && (
            <div style={{
              background: `${C.blue}12`,
              border: `1px solid ${C.blue}33`,
              borderRadius: 9,
              padding: '10px 12px',
              fontSize: '.72em',
              color: C.text,
              lineHeight: 1.5,
              marginBottom: 16,
            }}>
              Esta instalación aún no tiene usuarios. La primera cuenta será la
              propietaria y podrá invitar al resto.
            </div>
          )}

          <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {mode !== 'login' && (
              <div>
                <div style={label}>Nombre</div>
                <input
                  style={input}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Opcional"
                  autoComplete="name"
                />
              </div>
            )}

            <div>
              <div style={label}>Correo</div>
              <input
                style={input}
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            <div>
              <div style={label}>Contraseña</div>
              <input
                style={input}
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                minLength={mode === 'login' ? undefined : 12}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
              {mode !== 'login' && (
                <div style={{ fontSize: '.66em', color: C.muted, marginTop: 5 }}>
                  Mínimo 12 caracteres.
                </div>
              )}
            </div>

            {mode === 'invite' && (
              <div>
                <div style={label}>Código de invitación</div>
                <input
                  style={{ ...input, letterSpacing: '.12em', textTransform: 'uppercase' }}
                  value={invite}
                  onChange={e => setInvite(e.target.value)}
                  placeholder="XXXXX-XXXXX-XXXXX-XXXXX"
                  required
                />
              </div>
            )}

            {mode === 'bootstrap' && (
              <div>
                <div style={label}>Secreto de arranque</div>
                <input
                  style={input}
                  type="password"
                  value={bootstrapSecret}
                  onChange={e => setBootstrapSecret(e.target.value)}
                  required
                />
                <div style={{ fontSize: '.66em', color: C.muted, marginTop: 5 }}>
                  Es el valor de <code>AURUM_BOOTSTRAP_SECRET</code> del despliegue.
                </div>
              </div>
            )}

            {error && (
              <div style={{
                background: `${C.red}12`,
                border: `1px solid ${C.red}44`,
                borderRadius: 9,
                padding: '10px 12px',
                fontSize: '.74em',
                color: C.red,
              }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              style={{
                background: busy ? C.surf3 : C.gold,
                color: busy ? C.muted : C.bg,
                border: 'none',
                borderRadius: 9,
                padding: '12px 16px',
                fontSize: '.84em',
                fontWeight: 600,
                fontFamily: "'Sora',sans-serif",
                cursor: busy ? 'default' : 'pointer',
                marginTop: 4,
              }}
            >
              {busy ? 'Un momento…' : mode === 'login' ? 'Entrar' : 'Crear cuenta'}
            </button>
          </form>

          {config.googleEnabled && (
            <>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                margin: '18px 0 14px',
                color: C.faint,
                fontSize: '.66em',
              }}>
                <div style={{ flex: 1, height: 1, background: C.border2 }} />
                O BIEN
                <div style={{ flex: 1, height: 1, background: C.border2 }} />
              </div>
              {isNative ? (
                <button
                  type="button"
                  onClick={() => {
                    // Google rechaza OAuth dentro del webview de la app, así
                    // que se abre el navegador del sistema y se vuelve por
                    // aurum://auth.
                    void startGoogleLogin(mode === 'invite' ? invite : undefined).catch(() =>
                      setError('No se ha podido abrir el navegador para acceder con Google.'),
                    );
                  }}
                  style={googleButtonStyle}
                >
                  Continuar con Google
                </button>
              ) : (
                <a href={googleLoginUrl(mode === 'invite' ? invite : undefined)} style={googleButtonStyle}>
                  Continuar con Google
                </a>
              )}
              {mode === 'invite' && (
                <div style={{ fontSize: '.66em', color: C.muted, marginTop: 8, textAlign: 'center' }}>
                  Escribe el código antes de continuar con Google.
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ textAlign: 'center', marginTop: 18, fontSize: '.74em', color: C.muted }}>
          {mode === 'login' ? (
            <>
              ¿Tienes una invitación?{' '}
              <button onClick={() => { setMode('invite'); setError(null); }} style={linkStyle}>
                Actívala aquí
              </button>
            </>
          ) : mode === 'invite' ? (
            <>
              ¿Ya tienes cuenta?{' '}
              <button onClick={() => { setMode('login'); setError(null); }} style={linkStyle}>
                Accede
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const googleButtonStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  textAlign: 'center',
  background: C.surf2,
  border: `1px solid ${C.border2}`,
  borderRadius: 9,
  padding: '11px 16px',
  fontSize: '.8em',
  fontFamily: "'Sora',sans-serif",
  color: C.text,
  textDecoration: 'none',
  cursor: 'pointer',
};

const linkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: C.gold,
  cursor: 'pointer',
  fontSize: '1em',
  fontFamily: "'Sora',sans-serif",
  padding: 0,
  textDecoration: 'underline',
};
