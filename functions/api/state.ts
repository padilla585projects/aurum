/**
 * /api/state — estado por usuario. Sustituye a localStorage como fuente de
 * verdad: cartera, watchlist, memoria del asesor, presupuesto de tokens, etc.
 *
 *   GET    /api/state              → todo el estado del usuario
 *   GET    /api/state?keys=a,b     → solo esas claves
 *   PUT    /api/state              → escritura por lotes con versión optimista
 *   DELETE /api/state?key=a        → borra una clave
 *
 * Concurrencia: cada clave lleva un número de versión. Quien escribe manda la
 * versión que leyó; si entretanto otro dispositivo escribió, la operación se
 * rechaza con 409 y el valor actual, y decide el cliente. Sin esto, dos móviles
 * con la misma cuenta se pisarían la cartera en silencio.
 */

import type { PagesContext } from '../_lib/types.ts';
import { fail, json, readJson } from '../_lib/http.ts';

/** Formato de clave admitido. Evita usar la tabla como almacén genérico. */
const KEY_PATTERN = /^aurum-[a-z0-9-]{1,60}$/;

const MAX_VALUE_BYTES = 256 * 1024;      // por clave
const MAX_TOTAL_BYTES = 4 * 1024 * 1024; // por usuario
const MAX_KEYS = 64;
const MAX_ENTRIES_PER_WRITE = 32;

interface StateRow {
  key: string;
  value: string;
  version: number;
  updated_at: number;
}

interface WriteEntry {
  key?: unknown;
  value?: unknown;
  /** Versión leída por el cliente. Omitirla fuerza la escritura. */
  version?: unknown;
}

/* ── Lectura ─────────────────────────────────────────────────── */

export async function onRequestGet(context: PagesContext): Promise<Response> {
  const { request, env, data } = context;
  const user = data.user;
  if (!user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  const requested = new URL(request.url).searchParams.get('keys');
  const keys = requested
    ? requested.split(',').map(k => k.trim()).filter(k => KEY_PATTERN.test(k)).slice(0, MAX_KEYS)
    : null;

  let rows: StateRow[];
  if (keys) {
    if (keys.length === 0) return json({ state: {} });
    const placeholders = keys.map(() => '?').join(',');
    const result = await env.DB.prepare(
      `SELECT key, value, version, updated_at FROM user_state WHERE user_id = ? AND key IN (${placeholders})`,
    ).bind(user.id, ...keys).all<StateRow>();
    rows = result.results;
  } else {
    const result = await env.DB.prepare(
      `SELECT key, value, version, updated_at FROM user_state WHERE user_id = ?`,
    ).bind(user.id).all<StateRow>();
    rows = result.results;
  }

  const state: Record<string, { value: unknown; version: number; updatedAt: number }> = {};
  for (const row of rows) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      // Fila corrupta: se devuelve null en lugar de tumbar toda la lectura.
    }
    state[row.key] = { value: parsed, version: row.version, updatedAt: row.updated_at };
  }

  return json({ state });
}

/* ── Escritura ───────────────────────────────────────────────── */

export async function onRequestPut(context: PagesContext): Promise<Response> {
  const { request, env, data } = context;
  const user = data.user;
  if (!user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  const body = await readJson<{ entries?: unknown }>(request, MAX_TOTAL_BYTES);
  if (!body || !Array.isArray(body.entries)) {
    return fail(400, 'bad_request', 'Se esperaba { entries: [...] }.');
  }
  const entries = body.entries as WriteEntry[];
  if (entries.length === 0) return json({ results: {} });
  if (entries.length > MAX_ENTRIES_PER_WRITE) {
    return fail(400, 'too_many_entries', `Máximo ${MAX_ENTRIES_PER_WRITE} claves por escritura.`);
  }

  // Normalización y validación previa: o entra todo el lote, o no entra nada.
  const prepared: { key: string; serialized: string; expected: number | null }[] = [];
  for (const entry of entries) {
    if (typeof entry?.key !== 'string' || !KEY_PATTERN.test(entry.key)) {
      return fail(400, 'bad_key', `Clave no válida: ${String(entry?.key).slice(0, 60)}`);
    }
    if (entry.value === undefined) {
      return fail(400, 'bad_value', `Falta el valor de ${entry.key}.`);
    }
    const serialized = JSON.stringify(entry.value);
    if (serialized.length > MAX_VALUE_BYTES) {
      return fail(413, 'value_too_large', `El valor de ${entry.key} supera el límite por clave.`);
    }
    const expected = typeof entry.version === 'number' ? entry.version : null;
    prepared.push({ key: entry.key, serialized, expected });
  }

  // Estado actual de las claves implicadas, para versión y cuota.
  const placeholders = prepared.map(() => '?').join(',');
  const current = await env.DB.prepare(
    `SELECT key, version, size FROM user_state WHERE user_id = ? AND key IN (${placeholders})`,
  ).bind(user.id, ...prepared.map(p => p.key)).all<{ key: string; version: number; size: number }>();

  const currentByKey = new Map(current.results.map(r => [r.key, r]));

  const conflicts: Record<string, number> = {};
  for (const item of prepared) {
    const existing = currentByKey.get(item.key);
    if (item.expected !== null && (existing?.version ?? 0) !== item.expected) {
      conflicts[item.key] = existing?.version ?? 0;
    }
  }
  if (Object.keys(conflicts).length > 0) {
    return fail(409, 'version_conflict', 'El estado cambió desde otro dispositivo.', {
      'X-Conflict-Keys': Object.keys(conflicts).join(','),
    });
  }

  // Cuota total del usuario, contando el reemplazo de las claves que ya existen.
  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS keys, COALESCE(SUM(size), 0) AS bytes FROM user_state WHERE user_id = ?`,
  ).bind(user.id).first<{ keys: number; bytes: number }>();

  const replacedBytes = prepared.reduce((sum, p) => sum + (currentByKey.get(p.key)?.size ?? 0), 0);
  const newBytes = prepared.reduce((sum, p) => sum + p.serialized.length, 0);
  const projectedBytes = (totals?.bytes ?? 0) - replacedBytes + newBytes;
  const newKeyCount = prepared.filter(p => !currentByKey.has(p.key)).length;

  if (projectedBytes > MAX_TOTAL_BYTES) {
    return fail(413, 'quota_exceeded', 'Has superado el espacio de estado disponible.');
  }
  if ((totals?.keys ?? 0) + newKeyCount > MAX_KEYS) {
    return fail(413, 'too_many_keys', 'Has superado el número de claves permitido.');
  }

  const now = Date.now();
  const statements = prepared.map(item =>
    env.DB.prepare(
      `INSERT INTO user_state (user_id, key, value, version, size, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET
         value = excluded.value,
         version = user_state.version + 1,
         size = excluded.size,
         updated_at = excluded.updated_at`,
    ).bind(user.id, item.key, item.serialized, item.serialized.length, now),
  );
  await env.DB.batch(statements);

  // Versiones resultantes, para que el cliente actualice su copia local.
  const after = await env.DB.prepare(
    `SELECT key, version FROM user_state WHERE user_id = ? AND key IN (${placeholders})`,
  ).bind(user.id, ...prepared.map(p => p.key)).all<{ key: string; version: number }>();

  const results: Record<string, number> = {};
  for (const row of after.results) results[row.key] = row.version;

  return json({ results, updatedAt: now });
}

/* ── Borrado ─────────────────────────────────────────────────── */

export async function onRequestDelete(context: PagesContext): Promise<Response> {
  const { request, env, data } = context;
  const user = data.user;
  if (!user) return fail(401, 'unauthenticated', 'Necesitas iniciar sesión.');

  const key = new URL(request.url).searchParams.get('key');
  if (!key || !KEY_PATTERN.test(key)) return fail(400, 'bad_key', 'Clave no válida.');

  await env.DB.prepare(`DELETE FROM user_state WHERE user_id = ? AND key = ?`).bind(user.id, key).run();
  return json({ ok: true });
}
