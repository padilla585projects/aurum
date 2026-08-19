/**
 * Estado del usuario: caché en memoria, espejo en localStorage y sincronización
 * con /api/state.
 *
 * Por qué esta forma:
 *   · Los módulos de src/nexus leen el estado de forma síncrona en mitad de un
 *     razonamiento, así que la lectura tiene que ser inmediata → caché en
 *     memoria, poblada al iniciar sesión.
 *   · La aplicación tiene que seguir funcionando sin cobertura (es una PWA con
 *     APK) → toda escritura se guarda primero en local y se envía después.
 *   · Con multiusuario, dos cuentas pueden compartir dispositivo → el espejo
 *     local va namespaceado por usuario.
 *
 * Conflictos: cada clave lleva versión. Si el servidor rechaza la escritura
 * porque otro dispositivo cambió esa clave, se recarga la versión del servidor
 * y se reintenta una vez con el valor local. Es decir, en un empate gana el
 * último dispositivo que escribe. Es un compromiso conocido: evita perder lo
 * que el usuario acaba de introducir, a costa de poder pisar un cambio hecho a
 * la vez en otro sitio.
 */

import { ApiError, apiFetch, isOffline } from './api';

interface Entry {
  value: unknown;
  version: number;
  /** Pendiente de enviar al servidor. */
  dirty: boolean;
}

interface ServerState {
  state: Record<string, { value: unknown; version: number; updatedAt: number }>;
}

const cache = new Map<string, Entry>();
let currentUserId: string | null = null;
let hydrated = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing: Promise<void> | null = null;

const FLUSH_DELAY_MS = 1500;

/** Claves que existían antes del modo multiusuario, para la migración inicial. */
export const LEGACY_KEYS = [
  'aurum-portfolio',
  'aurum-portfolio-history',
  'aurum-user-profile',
  'aurum-profile',
  'aurum-goal',
  'aurum-watchlist',
  'aurum-price-alerts',
  'aurum-hist-auto',
  'aurum-alerts-v2',
  'aurum-recommendations-v2',
  'aurum-monitor-config-v2',
  'aurum-auto-invest-v1',
  'aurum-action-log-v1',
  'aurum-nexus-memory-v1',
  'aurum-lessons-v1',
  'aurum-token-budget-v1',
] as const;

/**
 * Claves que NO se sincronizan: son propias del dispositivo o contienen
 * credenciales que no deben salir de él.
 */
const DEVICE_ONLY = new Set(['aurum-price-refresh-ts', 'aurum-session-token']);

/**
 * La configuracion del backend privado va por su propio camino: contiene un
 * token, asi que no puede viajar por /api/state en claro. Se guarda cifrada en
 * /api/backend-config, pero se expone aqui bajo la misma clave de siempre para
 * que todo lo que ya la lee siga funcionando igual.
 */
const CLAVE_BACKEND = 'aurum-backend-config';

/* ── Espejo local ────────────────────────────────────────────── */

function mirrorKey(key: string): string {
  return `aurum:u:${currentUserId ?? 'anon'}:${key}`;
}

function readMirror(key: string): Entry | null {
  try {
    const raw = localStorage.getItem(mirrorKey(key));
    return raw ? (JSON.parse(raw) as Entry) : null;
  } catch {
    return null;
  }
}

function writeMirror(key: string, entry: Entry): void {
  try {
    localStorage.setItem(mirrorKey(key), JSON.stringify(entry));
  } catch {
    // Cuota de localStorage agotada: el servidor sigue siendo la fuente de
    // verdad, así que se pierde solo la copia de respaldo sin conexión.
  }
}

function mirrorKeysForUser(): string[] {
  const prefix = `aurum:u:${currentUserId ?? 'anon'}:`;
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(prefix)) out.push(k.slice(prefix.length));
    }
  } catch {
    /* almacenamiento no disponible */
  }
  return out;
}

/* ── Ciclo de vida ───────────────────────────────────────────── */

/**
 * Carga el estado del usuario. Primero el espejo local (para pintar de
 * inmediato) y después el servidor, que manda salvo en las claves con cambios
 * locales pendientes.
 */
export async function hydrate(userId: string): Promise<{ online: boolean }> {
  currentUserId = userId;
  cache.clear();

  for (const key of mirrorKeysForUser()) {
    const entry = readMirror(key);
    if (entry) cache.set(key, entry);
  }

  // Las dos cargas van en paralelo y por separado a propósito. Antes la del
  // backend colgaba de que /api/state hubiera ido bien, así que cualquier fallo
  // ahí dejaba los campos de Ajustes vacíos sin decir nada — y vacío se lee
  // como «se ha borrado», que es justo lo que no era.
  const [estado, backend] = await Promise.allSettled([
    apiFetch<ServerState>('/api/state'),
    apiFetch<RespuestaBackend>('/api/backend-config'),
  ]);

  if (backend.status === 'fulfilled' && backend.value.config) {
    cache.set(CLAVE_BACKEND, { value: backend.value.config, version: 0, dirty: false });
  }

  hydrated = true;

  if (estado.status === 'rejected') {
    if (isOffline(estado.reason)) return { online: false };
    throw estado.reason;
  }

  for (const [key, remote] of Object.entries(estado.value.state)) {
    const local = cache.get(key);
    // Un cambio local sin enviar no se pisa: se enviará en el próximo flush.
    if (local?.dirty) continue;
    const entry: Entry = { value: remote.value, version: remote.version, dirty: false };
    cache.set(key, entry);
    writeMirror(key, entry);
  }

  await migrateLegacy();
  void flush();
  return { online: true };
}

/**
 * Sube al servidor los datos que este dispositivo tuviera guardados del modo de
 * un solo usuario. Solo actúa sobre claves que el usuario aún no tiene en el
 * servidor, así que es segura de repetir y nunca sobrescribe datos de la nube.
 */
async function migrateLegacy(): Promise<void> {
  let migrated = 0;
  for (const key of LEGACY_KEYS) {
    if (cache.has(key)) continue;
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(key);
    } catch {
      continue;
    }
    if (raw === null) continue;
    try {
      const value = JSON.parse(raw);
      cache.set(key, { value, version: 0, dirty: true });
      migrated++;
    } catch {
      // Valor ilegible del esquema antiguo: se ignora en lugar de propagarlo.
    }
  }
  if (migrated > 0) await flush();
}

type RespuestaBackend = { config: ConfigBackend | null };
export interface ConfigBackend { url: string; apiKey: string; updatedAt?: number }

/**
 * Vuelve a pedir la configuracion del backend privado. La pantalla de Ajustes
 * la llama cuando no la encuentra en cache: esta clave no tiene espejo local
 * (contiene un token), asi que si la carga inicial fallo no hay de donde
 * sacarla y sin esto los campos se quedan vacios para siempre.
 */
export async function recargarConfigBackend(): Promise<ConfigBackend | null> {
  try {
    const { config } = await apiFetch<RespuestaBackend>('/api/backend-config');
    if (config) cache.set(CLAVE_BACKEND, { value: config, version: 0, dirty: false });
    return config;
  } catch {
    return null;
  }
}

/** Cierra la sesión de estado. No borra el espejo: sirve al volver a entrar. */
export function detach(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  cache.clear();
  currentUserId = null;
  hydrated = false;
}

export function isHydrated(): boolean {
  return hydrated;
}

/* ── Lectura y escritura ─────────────────────────────────────── */

export function get<T>(key: string, fallback: T): T {
  if (DEVICE_ONLY.has(key)) return readDeviceOnly(key, fallback);
  const entry = cache.get(key);
  return entry === undefined || entry.value === null || entry.value === undefined
    ? fallback
    : (entry.value as T);
}

export function set(key: string, value: unknown): void {
  if (DEVICE_ONLY.has(key)) return writeDeviceOnly(key, value);

  if (key === CLAVE_BACKEND) {
    // Se guarda en memoria para que la lectura sincrona la vea al momento, y
    // se manda cifrada al servidor para que siga al usuario a otros equipos.
    cache.set(key, { value, version: 0, dirty: false });
    const cfg = value as { url?: string; apiKey?: string } | null;
    if (cfg?.url && cfg?.apiKey) {
      void apiFetch('/api/backend-config', {
        method: 'PUT',
        body: JSON.stringify({ url: cfg.url, token: cfg.apiKey }),
      }).catch(() => {
        // Sin conexion queda en memoria; se reintenta al volver a guardar.
      });
    }
    return;
  }
  const previous = cache.get(key);
  const entry: Entry = { value, version: previous?.version ?? 0, dirty: true };
  cache.set(key, entry);
  writeMirror(key, entry);
  scheduleFlush();
}

export function remove(key: string): void {
  if (key === CLAVE_BACKEND) {
    cache.delete(key);
    void apiFetch('/api/backend-config', { method: 'DELETE' }).catch(() => {});
    return;
  }
  if (DEVICE_ONLY.has(key)) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignorado */
    }
    return;
  }
  cache.delete(key);
  try {
    localStorage.removeItem(mirrorKey(key));
  } catch {
    /* ignorado */
  }
  void apiFetch(`/api/state?key=${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => {
    // Sin conexión: la clave ya no está en local; volverá a bajar del servidor
    // en la próxima hidratación si el borrado no llegó a aplicarse.
  });
}

/** Claves que se quedan en el dispositivo (URL del backend privado, etc.). */
function readDeviceOnly<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeDeviceOnly(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignorado */
  }
}

/* ── Sincronización ──────────────────────────────────────────── */

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
}

/** Envía los cambios pendientes. Es seguro llamarla en cualquier momento. */
export async function flush(): Promise<void> {
  if (flushing) return flushing;
  if (!currentUserId) return;

  const dirty = [...cache.entries()].filter(([, e]) => e.dirty);
  if (dirty.length === 0) return;

  flushing = (async () => {
    // El endpoint acepta 32 claves por llamada.
    for (let i = 0; i < dirty.length; i += 32) {
      const batch = dirty.slice(i, i + 32);
      const entries = batch.map(([key, entry]) => ({ key, value: entry.value, version: entry.version }));
      try {
        const { results } = await apiFetch<{ results: Record<string, number> }>('/api/state', {
          method: 'PUT',
          body: JSON.stringify({ entries }),
        });
        applyVersions(results);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          await resolveConflict(batch.map(([key]) => key));
          continue;
        }
        if (isOffline(err)) return; // se reintenta en la siguiente escritura
        throw err;
      }
    }
  })().finally(() => {
    flushing = null;
  });

  return flushing;
}

function applyVersions(results: Record<string, number>): void {
  for (const [key, version] of Object.entries(results)) {
    const entry = cache.get(key);
    if (!entry) continue;
    const updated: Entry = { value: entry.value, version, dirty: false };
    cache.set(key, updated);
    writeMirror(key, updated);
  }
}

/**
 * Tras un 409: se leen las versiones actuales del servidor y se reintenta una
 * sola vez con el valor local. Si vuelve a fallar, el cambio queda pendiente y
 * se reintentará en la siguiente escritura.
 */
async function resolveConflict(keys: string[]): Promise<void> {
  const { state } = await apiFetch<ServerState>(`/api/state?keys=${keys.map(encodeURIComponent).join(',')}`);
  const entries = keys
    .map(key => {
      const local = cache.get(key);
      if (!local) return null;
      const version = state[key]?.version ?? 0;
      cache.set(key, { ...local, version });
      return { key, value: local.value, version };
    })
    .filter((e): e is { key: string; value: unknown; version: number } => e !== null);

  if (entries.length === 0) return;
  const { results } = await apiFetch<{ results: Record<string, number> }>('/api/state', {
    method: 'PUT',
    body: JSON.stringify({ entries }),
  });
  applyVersions(results);
}

/** Trae del servidor los cambios de otros dispositivos (llamar al recuperar el foco). */
export async function refresh(): Promise<void> {
  if (!currentUserId || !hydrated) return;
  try {
    const { state } = await apiFetch<ServerState>('/api/state');
    for (const [key, remote] of Object.entries(state)) {
      const local = cache.get(key);
      if (local?.dirty) continue;
      if (local && local.version >= remote.version) continue;
      const entry: Entry = { value: remote.value, version: remote.version, dirty: false };
      cache.set(key, entry);
      writeMirror(key, entry);
    }
  } catch {
    // Sin conexión: se sigue con la copia local.
  }
}
