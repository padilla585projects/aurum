/**
 * Prepara el esquema y deja la base vacía antes de cada prueba.
 *
 * Las migraciones se aplican una sola vez por worker; lo que se limpia entre
 * pruebas son las filas. Vaciar las tablas de forma explícita, en lugar de
 * confiar en el aislamiento del pool, hace que una prueba que cuenta usuarios
 * (`needsBootstrap`) siga diciendo la verdad aunque otra haya creado cuentas.
 */

import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach } from 'vitest';

/** Orden inverso a las dependencias, aunque D1 no fuerce las claves ajenas. */
const TABLES = [
  'audit_log',
  'ai_usage',
  'auth_exchange_codes',
  'user_state',
  'rate_limits',
  'invites',
  'sessions',
  'oauth_accounts',
  'users',
];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.batch(TABLES.map(table => env.DB.prepare(`DELETE FROM ${table}`)));
});
