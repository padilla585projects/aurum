/**
 * Claves de proveedor de IA que aporta el usuario.
 *
 * El servidor nunca devuelve una clave guardada: solo una pista con los últimos
 * caracteres. Por eso aquí no hay ningún estado que contenga la clave más allá
 * del momento de enviarla.
 */

import { apiFetch } from './api';

export interface ProviderKeyStatus {
  id: string;
  label: string;
  /** El despliegue tiene una clave compartida para este proveedor. */
  hasProjectKey: boolean;
  /** El usuario ha guardado la suya. */
  hasOwnKey: boolean;
  /** Últimos caracteres de la clave guardada, para reconocerla. */
  hint: string | null;
  model: string | null;
  updatedAt: number | null;
  /** true si los modelos están restringidos por usar la clave del proyecto. */
  restricted: boolean;
}

export async function fetchProviderKeys(): Promise<ProviderKeyStatus[]> {
  const { providers } = await apiFetch<{ providers: ProviderKeyStatus[] }>('/api/keys');
  return providers;
}

export async function saveProviderKey(provider: string, key: string, model?: string): Promise<void> {
  await apiFetch('/api/keys', {
    method: 'PUT',
    body: JSON.stringify({ provider, key, model: model?.trim() || undefined }),
  });
}

export async function deleteProviderKey(provider: string): Promise<void> {
  await apiFetch(`/api/keys?provider=${encodeURIComponent(provider)}`, { method: 'DELETE' });
}
