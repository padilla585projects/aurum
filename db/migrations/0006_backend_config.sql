-- Direccion y token del backend privado de cada usuario.
--
-- Se guarda aparte de user_state porque contiene una credencial: el token va
-- cifrado con AES-256-GCM y atado al usuario, igual que las claves de IA.
--
-- Diferencia con aquellas: este token SI vuelve al navegador, porque es el
-- navegador quien llama al backend por la tailnet. El cifrado protege la base
-- de datos si alguien la lee, no la sesion del usuario.
CREATE TABLE user_backend_config (
    user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    url        TEXT NOT NULL,
    token_enc  TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
