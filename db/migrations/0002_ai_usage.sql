-- Consumo de IA por usuario.
-- Necesario en multiusuario: sin esto no se puede saber quién gasta las claves
-- del proyecto ni aplicar cuotas por persona.
CREATE TABLE ai_usage (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider       TEXT NOT NULL,        -- 'anthropic' | 'openai' | 'deepseek'
  model          TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cached_tokens  INTEGER NOT NULL DEFAULT 0,
  status         INTEGER NOT NULL
);
CREATE INDEX idx_ai_usage_user_ts ON ai_usage(user_id, ts);
