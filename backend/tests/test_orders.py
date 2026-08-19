"""
Guardas de ejecución de órdenes.

Son cuatro y están puestas en este orden a propósito: interruptor maestro, doble
confirmación, idempotencia y límite diario acumulado. Ninguna prueba de este
fichero llega a tocar el broker; lo que se comprueba es justamente que no se
llegue si falta cualquiera de las cuatro.
"""

from __future__ import annotations

import pytest

import db
import main
from conftest import auth
from security import ALL_SCOPES, SCOPE_EXECUTE, SCOPE_READ

TRADE = {"ticker": "IWDA", "isin": "IE00B4L5Y983", "amount": 100.0, "name": "iShares Core MSCI World"}


@pytest.fixture
def inversor():
    """Token con permiso de ejecución."""
    token, token_id = db.create_token("inversor@aurum.test", role="user", scopes=[SCOPE_READ, SCOPE_EXECUTE])
    return {"token": token, "id": token_id, "email": "inversor@aurum.test"}


@pytest.fixture
def trading_activo(monkeypatch):
    """Levanta el interruptor maestro solo para la prueba que lo pide."""
    monkeypatch.setattr(main, "TRADING_ENABLED", True)


def preparar(client, token, trades=(TRADE,), side="buy") -> str:
    """Primer paso de la doble confirmación; devuelve el token del plan."""
    res = client.post(
        "/orders/prepare",
        json={"side": side, "trades": [{"isin": t["isin"], "amount": t["amount"]} for t in trades]},
        headers=auth(token),
    )
    assert res.status_code == 200, res.text
    return res.json()["confirmation_token"]


class TestPreparacion:
    def test_congela_el_plan_y_devuelve_un_token(self, client, inversor):
        res = client.post(
            "/orders/prepare",
            json={"side": "buy", "trades": [{"isin": TRADE["isin"], "amount": 100}]},
            headers=auth(inversor["token"]),
        )

        assert res.status_code == 200
        cuerpo = res.json()
        assert cuerpo["confirmation_token"]
        assert cuerpo["total_eur"] == 100
        assert cuerpo["plan"] == {"side": "buy", "items": [{"isin": TRADE["isin"], "amount": 100.0, "shares": 0.0}]}
        assert cuerpo["expires_in_seconds"] == db.CONFIRMATION_TTL_SECONDS
        assert cuerpo["trading_enabled"] is False

    def test_rechaza_una_lista_vacia(self, client, inversor):
        res = client.post("/orders/prepare", json={"side": "buy", "trades": []}, headers=auth(inversor["token"]))
        assert res.status_code == 400

    def test_solo_admite_comprar_o_vender(self, client, inversor):
        res = client.post(
            "/orders/prepare",
            json={"side": "regalar", "trades": [{"isin": TRADE["isin"], "amount": 100}]},
            headers=auth(inversor["token"]),
        )
        assert res.status_code == 422

    def test_exige_token(self, client):
        assert client.post("/orders/prepare", json={"side": "buy", "trades": []}).status_code == 401

    def test_el_plan_es_canonico_para_poder_compararlo(self):
        # Mismo contenido en distinto orden y con más decimales: mismo plan.
        uno = main._order_plan("buy", [{"isin": "B", "amount": 50}, {"isin": "A", "amount": 100.004}])
        otro = main._order_plan("buy", [{"isin": "A", "amount": 100.0041}, {"isin": "B", "amount": 50.0}])
        assert uno == otro
        assert [i["isin"] for i in uno["items"]] == ["A", "B"]


class TestInterruptorMaestro:
    def test_con_la_ejecucion_desactivada_no_se_llega_a_nada(self, client, inversor):
        res = client.post("/invest", json={"trades": [TRADE]}, headers=auth(inversor["token"]))

        assert res.status_code == 503
        assert "AURUM_TRADING_ENABLED" in res.json()["detail"]
        assert db.recent_orders("inversor@aurum.test") == []

    def test_un_token_sin_permiso_de_ejecucion_se_para_antes(self, client, usuario):
        res = client.post("/invest", json={"trades": [TRADE]}, headers=auth(usuario["token"]))
        assert res.status_code == 403
        assert SCOPE_EXECUTE in res.json()["detail"]

    def test_sin_token_no_se_llega(self, client):
        assert client.post("/invest", json={"trades": [TRADE]}).status_code == 401


class TestDobleConfirmacion:
    def test_sin_token_de_confirmacion_se_exige_el_primer_paso(self, client, inversor, trading_activo):
        res = client.post("/invest", json={"trades": [TRADE]}, headers=auth(inversor["token"]))

        assert res.status_code == 428
        assert "/orders/prepare" in res.json()["detail"]

    def test_un_token_inventado_o_caducado_no_vale(self, client, inversor, trading_activo):
        res = client.post(
            "/invest",
            json={"trades": [TRADE], "confirmation_token": "inventado"},
            headers=auth(inversor["token"]),
        )
        assert res.status_code == 403

    def test_no_se_puede_cambiar_el_plan_entre_los_dos_pasos(self, client, inversor, trading_activo):
        # Se confirma una compra de 100 € y se intenta ejecutar una de 5.000 €.
        token = preparar(client, inversor["token"])
        res = client.post(
            "/invest",
            json={"trades": [{**TRADE, "amount": 5000.0}], "confirmation_token": token},
            headers=auth(inversor["token"]),
        )

        assert res.status_code == 409
        assert any(e["event"] == "order_confirmation_mismatch" for e in db.recent_audit())
        assert db.recent_orders("inversor@aurum.test") == []

    def test_el_token_de_confirmacion_vale_una_sola_vez(self, client, inversor, trading_activo):
        token = preparar(client, inversor["token"])
        cuerpo = {"trades": [TRADE], "confirmation_token": token, "idempotency_key": "clave-1"}

        # La primera llegará hasta el broker y fallará ahí (no hay sesión).
        primera = client.post("/invest", json=cuerpo, headers=auth(inversor["token"]))
        assert primera.status_code == 401

        # La segunda ni siquiera pasa de la confirmación, ya consumida.
        segunda = client.post(
            "/invest",
            json={"trades": [TRADE], "confirmation_token": token, "idempotency_key": "clave-2"},
            headers=auth(inversor["token"]),
        )
        assert segunda.status_code == 403


class TestIdempotencia:
    def test_repetir_la_misma_orden_devuelve_el_resultado_guardado(self, client, inversor, trading_activo):
        db.record_order(
            "orden-previa", "clave-repetida", "inversor@aurum.test", "buy",
            TRADE["isin"], TRADE["amount"], "executed", ticker=TRADE["ticker"], broker_order_id="TR-1",
        )
        token = preparar(client, inversor["token"])

        res = client.post(
            "/invest",
            json={"trades": [TRADE], "confirmation_token": token, "idempotency_key": "clave-repetida"},
            headers=auth(inversor["token"]),
        )

        assert res.status_code == 200
        cuerpo = res.json()
        assert cuerpo["replayed"] is True
        assert cuerpo["total_executed"] == 1
        assert cuerpo["results"][0]["broker_order_id"] == "TR-1"
        # No se ha registrado ninguna orden nueva.
        assert len(db.recent_orders("inversor@aurum.test")) == 1
        assert any(e["event"] == "order_idempotent_replay" for e in db.recent_audit())

    def test_la_clave_de_otro_usuario_no_se_reutiliza(self, client, inversor, trading_activo):
        db.record_order(
            "orden-de-otro", "clave-repetida", "otro@aurum.test", "buy",
            TRADE["isin"], TRADE["amount"], "executed",
        )
        token = preparar(client, inversor["token"])

        res = client.post(
            "/invest",
            json={"trades": [TRADE], "confirmation_token": token, "idempotency_key": "clave-repetida"},
            headers=auth(inversor["token"]),
        )
        # No hay repetición que devolver: sigue adelante y se para en el broker.
        assert res.status_code == 401


class TestLimiteDiario:
    def test_corta_cuando_el_acumulado_de_24h_superaria_el_tope(self, client, inversor, trading_activo):
        db.record_order("o1", "k1", "inversor@aurum.test", "buy", "ISIN1", 950.0, "executed")
        token = preparar(client, inversor["token"])

        res = client.post(
            "/invest",
            json={"trades": [TRADE], "confirmation_token": token},
            headers=auth(inversor["token"]),
        )

        assert res.status_code == 429
        assert "950.00" in res.json()["detail"]

    def test_el_acumulado_es_por_usuario(self, client, inversor, trading_activo):
        db.record_order("o1", "k1", "otro@aurum.test", "buy", "ISIN1", 950.0, "executed")
        token = preparar(client, inversor["token"])

        res = client.post(
            "/invest",
            json={"trades": [TRADE], "confirmation_token": token},
            headers=auth(inversor["token"]),
        )
        # El gasto de otra cuenta no consume el límite de esta.
        assert res.status_code == 401


class TestHistorial:
    def test_cada_usuario_ve_solo_sus_ordenes(self, client, inversor, owner):
        db.record_order("o1", "k1", "inversor@aurum.test", "buy", "ISIN1", 100.0, "executed")
        db.record_order("o2", "k2", "owner@aurum.test", "buy", "ISIN2", 200.0, "executed")

        res = client.get("/orders", headers=auth(inversor["token"]))
        assert res.status_code == 200

        cuerpo = res.json()
        assert [o["id"] for o in cuerpo["orders"]] == ["o1"]
        assert cuerpo["executed_today_eur"] == 100.0
        assert cuerpo["max_daily_eur"] == 1000

    def test_exige_token(self, client):
        assert client.get("/orders").status_code == 401


class TestClaveDeIdempotencia:
    def test_si_el_cliente_no_la_manda_se_deriva_del_plan(self):
        plan = main._order_plan("buy", [{"isin": "A", "amount": 100}])
        otro = main._order_plan("buy", [{"isin": "A", "amount": 200}])

        assert main._idempotency_key("", plan) == main._idempotency_key("", plan)
        assert main._idempotency_key("", plan) != main._idempotency_key("", otro)

    def test_la_del_cliente_manda_y_se_recorta(self):
        plan = main._order_plan("buy", [{"isin": "A", "amount": 100}])
        assert main._idempotency_key("  mi-clave  ", plan) == "mi-clave"
        assert len(main._idempotency_key("x" * 200, plan)) == 80
