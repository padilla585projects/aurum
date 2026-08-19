"""
Persistencia del backend privado.

Antes, tokens, credenciales y órdenes vivían en memoria y se perdían en cada
reinicio. Estas pruebas fijan lo que se espera ahora de la capa de SQLite:
tokens revocables de uno en uno, credenciales cifradas en reposo, órdenes
idempotentes y confirmaciones de un solo uso.
"""

from __future__ import annotations

import time

import db
from security import SCOPE_ADMIN, SCOPE_EXECUTE, SCOPE_READ, hash_token


class TestTokens:
    def test_el_valor_en_claro_no_se_guarda(self):
        token, token_id = db.create_token("ana@aurum.test", role="user", scopes=[SCOPE_READ])
        fila = db.connect().execute("SELECT token_hash FROM api_tokens WHERE id = ?", (token_id,)).fetchone()
        assert fila["token_hash"] == hash_token(token)
        assert token not in fila["token_hash"]

    def test_authenticate_devuelve_rol_y_ambitos(self):
        token, token_id = db.create_token("ana@aurum.test", role="owner", scopes=[SCOPE_READ, SCOPE_ADMIN])
        principal = db.authenticate(token)

        assert principal is not None
        assert principal.user_email == "ana@aurum.test"
        assert principal.role == "owner"
        assert principal.scopes == {SCOPE_READ, SCOPE_ADMIN}
        assert principal.token_id == token_id
        assert principal.is_owner

    def test_normaliza_el_correo(self):
        token, _ = db.create_token("  Ana@AURUM.test ")
        assert db.authenticate(token).user_email == "ana@aurum.test"

    def test_descarta_ambitos_desconocidos_y_nunca_deja_un_token_sin_permisos(self):
        token, _ = db.create_token("ana@aurum.test", scopes=["inventado", SCOPE_EXECUTE])
        assert db.authenticate(token).scopes == {SCOPE_EXECUTE}

        vacio, _ = db.create_token("ana@aurum.test", scopes=["solo-inventados"])
        assert db.authenticate(vacio).scopes == {SCOPE_READ}

    def test_rechaza_token_desconocido_vacio_o_revocado(self):
        assert db.authenticate("no-existe") is None
        assert db.authenticate("") is None

        token, token_id = db.create_token("ana@aurum.test")
        assert db.revoke_token(token_id, "owner@aurum.test") is True
        assert db.authenticate(token) is None
        # Revocar dos veces no vuelve a registrar nada.
        assert db.revoke_token(token_id, "owner@aurum.test") is False

    def test_rechaza_un_token_caducado(self):
        token, token_id = db.create_token("ana@aurum.test", ttl_days=1)
        db.connect().execute("UPDATE api_tokens SET expires_at = ? WHERE id = ?", (time.time() - 1, token_id))
        db.connect().commit()
        assert db.authenticate(token) is None

    def test_anota_el_ultimo_uso(self):
        token, token_id = db.create_token("ana@aurum.test")
        assert db.connect().execute("SELECT last_used_at FROM api_tokens WHERE id = ?", (token_id,)).fetchone()[0] is None

        db.authenticate(token)
        assert db.connect().execute("SELECT last_used_at FROM api_tokens WHERE id = ?", (token_id,)).fetchone()[0] is not None

    def test_count_tokens_no_cuenta_los_revocados(self):
        assert db.count_tokens() == 0
        _, primero = db.create_token("ana@aurum.test")
        db.create_token("bruno@aurum.test")
        assert db.count_tokens() == 2

        db.revoke_token(primero, "owner@aurum.test")
        assert db.count_tokens() == 1

    def test_el_listado_no_incluye_ningun_secreto(self):
        token, _ = db.create_token("ana@aurum.test", label="portátil")
        listado = db.list_tokens()
        assert len(listado) == 1
        assert token not in str(listado)
        assert "token_hash" not in listado[0]


class TestCredencialesDeBroker:
    def test_ida_y_vuelta_por_usuario(self):
        db.set_broker_credentials("ana@aurum.test", "+34600000001", "1111")
        db.set_broker_credentials("bruno@aurum.test", "+34600000002", "2222")

        ana = db.get_broker_credentials("ana@aurum.test")
        bruno = db.get_broker_credentials("BRUNO@aurum.test")  # el correo se normaliza

        assert (ana.phone, ana.pin) == ("+34600000001", "1111")
        assert (bruno.phone, bruno.pin) == ("+34600000002", "2222")

    def test_en_la_tabla_no_hay_nada_legible(self):
        db.set_broker_credentials("ana@aurum.test", "+34600000001", "1111")
        fila = db.connect().execute("SELECT phone_enc, pin_enc FROM broker_credentials").fetchone()
        assert "+34600000001" not in fila["phone_enc"]
        assert "1111" not in fila["pin_enc"]

    def test_guardar_de_nuevo_sustituye_en_lugar_de_duplicar(self):
        db.set_broker_credentials("ana@aurum.test", "+34600000001", "1111")
        db.set_broker_credentials("ana@aurum.test", "+34600000009", "9999")

        assert db.connect().execute("SELECT COUNT(*) FROM broker_credentials").fetchone()[0] == 1
        assert db.get_broker_credentials("ana@aurum.test").pin == "9999"

    def test_consulta_y_borrado(self):
        assert db.has_broker_credentials("ana@aurum.test") is False
        assert db.get_broker_credentials("ana@aurum.test") is None

        db.set_broker_credentials("ana@aurum.test", "+34600000001", "1111")
        assert db.has_broker_credentials("ana@aurum.test") is True

        db.delete_broker_credentials("ana@aurum.test")
        assert db.has_broker_credentials("ana@aurum.test") is False


class TestOrdenes:
    def test_una_clave_de_idempotencia_identifica_la_orden_ya_procesada(self):
        assert db.find_order("ana@aurum.test", "clave-1") is None

        db.record_order("o1", "clave-1", "ana@aurum.test", "buy", "IE00B4L5Y983", 100.0, "executed", ticker="IWDA")
        orden = db.find_order("ana@aurum.test", "clave-1")

        assert orden["status"] == "executed"
        assert orden["amount_eur"] == 100.0
        # La misma clave en otra cuenta es otra orden distinta.
        assert db.find_order("bruno@aurum.test", "clave-1") is None

    def test_el_importe_del_dia_solo_suma_lo_ejecutado_en_24h(self):
        db.record_order("o1", "k1", "ana@aurum.test", "buy", "ISIN1", 100.0, "executed")
        db.record_order("o2", "k2", "ana@aurum.test", "buy", "ISIN2", 50.0, "error")
        db.record_order("o3", "k3", "ana@aurum.test", "buy", "ISIN3", 25.0, "pending_confirmation")
        db.record_order("o4", "k4", "bruno@aurum.test", "buy", "ISIN4", 500.0, "executed")

        assert db.executed_today_eur("ana@aurum.test") == 100.0

        # Una orden de anteayer ya no cuenta para el límite diario.
        db.connect().execute("UPDATE order_log SET created_at = ? WHERE id = 'o1'", (time.time() - 2 * 86400,))
        db.connect().commit()
        assert db.executed_today_eur("ana@aurum.test") == 0.0

    def test_el_historial_es_por_usuario_y_del_mas_reciente_al_mas_antiguo(self):
        db.record_order("o1", "k1", "ana@aurum.test", "buy", "ISIN1", 10.0, "executed")
        time.sleep(0.01)
        db.record_order("o2", "k2", "ana@aurum.test", "buy", "ISIN2", 20.0, "executed")
        db.record_order("o3", "k3", "bruno@aurum.test", "buy", "ISIN3", 30.0, "executed")

        historial = db.recent_orders("ana@aurum.test")
        assert [o["id"] for o in historial] == ["o2", "o1"]


class TestConfirmaciones:
    PLAN = {"side": "buy", "items": [{"isin": "IE00B4L5Y983", "amount": 100.0, "shares": 0.0}]}

    def test_se_consume_una_sola_vez(self):
        token = db.create_confirmation("ana@aurum.test", self.PLAN)

        assert db.consume_confirmation("ana@aurum.test", token) == self.PLAN
        assert db.consume_confirmation("ana@aurum.test", token) is None

    def test_no_vale_para_otro_usuario(self):
        token = db.create_confirmation("ana@aurum.test", self.PLAN)
        assert db.consume_confirmation("bruno@aurum.test", token) is None
        # Y sigue disponible para su dueño.
        assert db.consume_confirmation("ana@aurum.test", token) == self.PLAN

    def test_caduca(self):
        token = db.create_confirmation("ana@aurum.test", self.PLAN)
        db.connect().execute("UPDATE order_confirmations SET expires_at = ?", (time.time() - 1,))
        db.connect().commit()
        assert db.consume_confirmation("ana@aurum.test", token) is None

    def test_el_token_se_guarda_hasheado(self):
        token = db.create_confirmation("ana@aurum.test", self.PLAN)
        guardado = db.connect().execute("SELECT token FROM order_confirmations").fetchone()[0]
        assert guardado == hash_token(token)

    def test_un_token_inventado_no_vale(self):
        assert db.consume_confirmation("ana@aurum.test", "inventado") is None


class TestAuditoria:
    def test_registra_y_devuelve_lo_mas_reciente(self):
        db.audit("prueba", "ana@aurum.test", {"detalle": 1})
        entradas = db.recent_audit()

        assert entradas[0]["event"] == "prueba"
        assert entradas[0]["user_email"] == "ana@aurum.test"

    def test_nunca_tumba_la_peticion_que_la_origina(self):
        # Un detalle que no se puede serializar se pierde, pero no propaga la
        # excepción: la auditoría no debe hacer fallar la operación auditada.
        db.audit("no_serializable", "ana@aurum.test", {"objeto": object()})
        assert all(e["event"] != "no_serializable" for e in db.recent_audit())

    def test_recorta_los_detalles_muy_largos(self):
        db.audit("largo", "ana@aurum.test", {"texto": "x" * 5000})
        assert len(db.recent_audit()[0]["detail"]) <= 2000
