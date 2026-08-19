-- Motivo de parada devuelto por el proveedor.
-- Sin esto, una respuesta que el frontend descarta no deja forma de saber por
-- qué: en la práctica el usuario ve «Sin respuesta» y la telemetría dice 200.
ALTER TABLE ai_usage ADD COLUMN stop_reason TEXT;
