-- Códigos de un solo uso para el acceso desde la APK.
--
-- El retorno de Google no puede escribir una cookie en la aplicación nativa, y
-- mandar el token de sesión dentro del deep link lo dejaría expuesto: en
-- Android otra aplicación puede registrar el mismo esquema y recibir la URL.
--
-- En su lugar viaja un código efímero. La sesión no se crea hasta que la app lo
-- canjea, así que esta tabla nunca contiene una credencial utilizable: solo la
-- huella del código y a qué usuario corresponde.
CREATE TABLE auth_exchange_codes (
    code_hash   TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    consumed_at INTEGER
);
CREATE INDEX idx_exchange_expires ON auth_exchange_codes(expires_at);
