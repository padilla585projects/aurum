/**
 * Identidad, sesiones e invitaciones sobre D1.
 *
 * El token de sesión solo existe en claro en el navegador: en la base de datos
 * se guarda su SHA-256, igual que los códigos de invitación.
 */

import type { Env, SessionUser } from './types.ts';
import { clientIp, userAgent } from './http.ts';
import { hashToken, randomId, randomToken, hashPassword, timingSafeEqual } from './crypto.ts';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 días
export const SESSION_TTL_SECONDS = SESSION_TTL_MS / 1000;
const LAST_SEEN_THROTTLE_MS = 6 * 60 * 60 * 1000;          // no escribir más de 1 vez cada 6 h
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;            // 14 días

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  role: 'owner' | 'user';
  status: 'active' | 'suspended';
  password_hash: string | null;
  email_verified: number;
}

/* ── Usuarios ────────────────────────────────────────────────── */

export async function findUserByEmail(env: Env, email: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, email, name, role, status, password_hash, email_verified FROM users WHERE email = ?`,
  ).bind(email).first<UserRow>();
}

export async function findUserById(env: Env, id: string): Promise<UserRow | null> {
  return env.DB.prepare(
    `SELECT id, email, name, role, status, password_hash, email_verified FROM users WHERE id = ?`,
  ).bind(id).first<UserRow>();
}

export async function countUsers(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users`).first<{ n: number }>();
  return row?.n ?? 0;
}

export async function createUser(env: Env, params: {
  email: string;
  passwordHash: string | null;
  name: string | null;
  role: 'owner' | 'user';
  emailVerified: boolean;
}): Promise<SessionUser> {
  const id = randomId();
  await env.DB.prepare(
    `INSERT INTO users (id, email, email_verified, password_hash, name, role, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?)`,
  ).bind(
    id,
    params.email,
    params.emailVerified ? 1 : 0,
    params.passwordHash,
    params.name,
    params.role,
    Date.now(),
  ).run();
  return { id, email: params.email, name: params.name, role: params.role, status: 'active' };
}

export async function setPasswordHash(env: Env, userId: string, passwordHash: string): Promise<void> {
  await env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(passwordHash, userId).run();
}

/* ── Sesiones ────────────────────────────────────────────────── */

export async function createSession(env: Env, userId: string, request: Request): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(32);
  const id = await hashToken(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, userId, now, expiresAt, now, userAgent(request), clientIp(request)).run();

  await env.DB.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`).bind(now, userId).run();
  return { token, expiresAt };
}

export interface ResolvedSession {
  user: SessionUser;
  sessionId: string;
}

/**
 * Valida el token y devuelve el usuario. Rechaza sesiones caducadas y cuentas
 * suspendidas; refresca last_seen_at como mucho una vez cada 6 h para no
 * convertir cada petición en una escritura de D1.
 */
export async function resolveSession(env: Env, token: string | null): Promise<ResolvedSession | null> {
  if (!token) return null;
  const id = await hashToken(token);

  const row = await env.DB.prepare(
    `SELECT s.id AS session_id, s.expires_at, s.last_seen_at,
            u.id, u.email, u.name, u.role, u.status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
  ).bind(id).first<{
    session_id: string; expires_at: number; last_seen_at: number;
    id: string; email: string; name: string | null; role: 'owner' | 'user'; status: 'active' | 'suspended';
  }>();

  if (!row) return null;

  const now = Date.now();
  if (row.expires_at <= now) {
    await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(id).run();
    return null;
  }
  if (row.status !== 'active') return null;

  if (now - row.last_seen_at > LAST_SEEN_THROTTLE_MS) {
    await env.DB.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`).bind(now, id).run();
  }

  return {
    sessionId: row.session_id,
    user: { id: row.id, email: row.email, name: row.name, role: row.role, status: row.status },
  };
}

export async function revokeSession(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE id = ?`).bind(sessionId).run();
}

/** Cierra todas las sesiones del usuario (cambio de contraseña, sospecha de robo). */
export async function revokeAllSessions(env: Env, userId: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(userId).run();
}

/* ── Invitaciones ────────────────────────────────────────────── */

export async function createInvite(env: Env, params: {
  code: string;
  email: string | null;
  role: 'owner' | 'user';
  createdBy: string;
}): Promise<{ expiresAt: number }> {
  const expiresAt = Date.now() + INVITE_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO invites (code_hash, email, role, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(await hashToken(params.code), params.email, params.role, params.createdBy, Date.now(), expiresAt).run();
  return { expiresAt };
}

export type InviteCheck =
  | { ok: true; role: 'owner' | 'user'; codeHash: string }
  | { ok: false; message: string };

/**
 * Comprueba la invitación sin consumirla. Si lleva email asociado, debe
 * coincidir exactamente con el del registro.
 */
export async function checkInvite(env: Env, code: string, email: string): Promise<InviteCheck> {
  const codeHash = await hashToken(code.trim().toUpperCase());
  const row = await env.DB.prepare(
    `SELECT code_hash, email, role, expires_at, used_at FROM invites WHERE code_hash = ?`,
  ).bind(codeHash).first<{ code_hash: string; email: string | null; role: 'owner' | 'user'; expires_at: number; used_at: number | null }>();

  if (!row) return { ok: false, message: 'Invitación no válida.' };
  if (row.used_at) return { ok: false, message: 'Esa invitación ya se ha usado.' };
  if (row.expires_at <= Date.now()) return { ok: false, message: 'La invitación ha caducado.' };
  if (row.email && !timingSafeEqual(row.email, email)) {
    return { ok: false, message: 'La invitación está emitida para otro correo.' };
  }
  return { ok: true, role: row.role, codeHash: row.code_hash };
}

/**
 * Marca la invitación como usada. El UPDATE condicionado a used_at IS NULL
 * evita que dos registros simultáneos consuman el mismo código.
 */
export async function consumeInvite(env: Env, codeHash: string, userId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE invites SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL`,
  ).bind(Date.now(), userId, codeHash).run();
  return (res.meta.changes ?? 0) > 0;
}

/* ── Auditoría ───────────────────────────────────────────────── */

export async function audit(env: Env, entry: {
  userId?: string | null;
  event: string;
  route?: string;
  status?: number;
  ip?: string;
  detail?: unknown;
}): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO audit_log (ts, user_id, event, route, status, ip, detail) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      Date.now(),
      entry.userId ?? null,
      entry.event,
      entry.route ?? null,
      entry.status ?? null,
      entry.ip ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail).slice(0, 2000),
    ).run();
  } catch {
    // La auditoría nunca debe tumbar la petición que la origina.
  }
}

/* ── Alta del primer owner ───────────────────────────────────── */

/**
 * Mientras no exista ningún usuario, el registro se permite con
 * AURUM_BOOTSTRAP_SECRET en lugar de invitación. Después deja de funcionar,
 * exista o no la variable.
 */
export async function bootstrapAllowed(env: Env, secret: unknown): Promise<boolean> {
  if (!env.AURUM_BOOTSTRAP_SECRET) return false;
  if (typeof secret !== 'string' || !timingSafeEqual(secret, env.AURUM_BOOTSTRAP_SECRET)) return false;
  return (await countUsers(env)) === 0;
}

export { hashPassword };
