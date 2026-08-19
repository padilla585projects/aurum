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

/**
 * Guarda la clave, el modelo o ambos. Con una clave ya guardada se puede
 * cambiar solo el modelo: la clave no es legible, asi que volver a pedirla
 * obligaria a ir a buscarla a la consola del proveedor.
 */
export async function saveProviderKey(provider: string, key: string, model?: string): Promise<void> {
  await apiFetch('/api/keys', {
    method: 'PUT',
    body: JSON.stringify({
      provider,
      key: key.trim() || undefined,
      model: model?.trim() || undefined,
    }),
  });
}

export async function deleteProviderKey(provider: string): Promise<void> {
  await apiFetch(`/api/keys?provider=${encodeURIComponent(provider)}`, { method: 'DELETE' });
}

/** Valor que se guarda para que AURUM elija el modelo en cada llamada. */
export const MODELO_AUTOMATICO = 'auto';

export interface ModeloDisponible {
  id: string;
  nombre: string;
  entrada: number | null;
  salida: number | null;
  contexto: number | null;
  gratuito: boolean;
}

export interface CatalogoModelos {
  models: ModeloDisponible[];
  /** A que resuelve «Auto» ahora mismo, para poder enseñarlo. */
  auto: { id: string; salida: number | null } | null;
  autoDisponible: boolean;
}

/**
 * Catalogo en vivo del proveedor. Se consulta al proveedor en cada carga en vez
 * de mantener una lista en el codigo: estos catalogos cambian solos, y los
 * modelos gratuitos de OpenRouter aparecen y desaparecen.
 */
export async function fetchModelos(provider: string): Promise<CatalogoModelos> {
  return apiFetch<CatalogoModelos>(`/api/models?provider=${encodeURIComponent(provider)}`);
}
