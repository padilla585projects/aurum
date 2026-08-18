/**
 * Contexto de sesión, para que cualquier parte de la aplicación pueda saber
 * quién ha iniciado sesión y cerrarla.
 */

import { createContext, useContext } from 'react';
import type { SessionUser } from './session';

export interface SessionContextValue {
  user: SessionUser;
  /** true si el estado se está sirviendo desde la copia local sin conexión. */
  offline: boolean;
  signOut: (everywhere?: boolean) => Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession se ha usado fuera de SessionContext.');
  return ctx;
}
