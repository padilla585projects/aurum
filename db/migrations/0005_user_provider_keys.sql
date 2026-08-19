-- Claves de proveedor de IA que aporta cada usuario desde Ajustes.
--
-- Se guardan cifradas con AES-256-GCM: si alguien lee la base de datos no
-- obtiene claves utilizables. El criptograma va atado al par (usuario,
-- proveedor), asi que la fila de una persona no se descifra como la de otra.
--
-- `hint` son los ultimos caracteres en claro, lo unico que se le devuelve al
-- cliente para que reconozca cual tiene puesta.
CREATE TABLE user_provider_keys (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider   TEXT NOT NULL,
    key_enc    TEXT NOT NULL,
    hint       TEXT NOT NULL,
    model      TEXT,               -- modelo preferido, para proveedores con catalogo variable
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, provider)
);
