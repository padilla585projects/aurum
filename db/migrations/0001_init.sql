-- AURUM · esquema multiusuario
-- Aplicar con: npx wrangler d1 migrations apply aurum --remote

-- ── Identidad ────────────────────────────────────────────────
CREATE TABLE users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,          -- siempre en minúsculas
  email_verified INTEGER NOT NULL DEFAULT 0,
  password_hash  TEXT,                          -- NULL si la cuenta es solo OAuth
  name           TEXT,
  role           TEXT NOT NULL DEFAULT 'user',  -- 'owner' | 'user'
  status         TEXT NOT NULL DEFAULT 'active',-- 'active' | 'suspended'
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

CREATE TABLE oauth_accounts (
  provider         TEXT NOT NULL,               -- 'google'
  provider_user_id TEXT NOT NULL,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email            TEXT,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (provider, provider_user_id)
);
CREATE INDEX idx_oauth_user ON oauth_accounts(user_id);

-- El token de sesión nunca se guarda en claro: la PK es su SHA-256.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT,
  ip           TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Registro cerrado: sin invitación válida no se crea cuenta.
CREATE TABLE invites (
  code_hash  TEXT PRIMARY KEY,
  email      TEXT,                              -- si no es NULL, restringe a ese correo
  role       TEXT NOT NULL DEFAULT 'user',
  created_by TEXT REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  used_by    TEXT REFERENCES users(id)
);
CREATE INDEX idx_invites_email ON invites(email);

-- ── Límites y auditoría ──────────────────────────────────────
CREATE TABLE rate_limits (
  bucket       TEXT PRIMARY KEY,                -- "<sujeto>:<ruta>:<ventana>"
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX idx_rate_limits_expires ON rate_limits(expires_at);

CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  user_id TEXT,
  event   TEXT NOT NULL,
  route   TEXT,
  status  INTEGER,
  ip      TEXT,
  detail  TEXT
);
CREATE INDEX idx_audit_user_ts ON audit_log(user_id, ts);
CREATE INDEX idx_audit_ts ON audit_log(ts);

-- ── Estado por usuario ───────────────────────────────────────
-- Sustituye a localStorage: una fila por (usuario, clave), valor JSON.
CREATE TABLE user_state (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,        -- control de concurrencia optimista
  size       INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idx_user_state_updated ON user_state(user_id, updated_at);
