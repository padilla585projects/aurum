"""
API de identidad y credenciales de broker.

El backend privado dejó de tener una clave única compartida: ahora cada persona
lleva su token, con rol y ámbitos. Estas pruebas fijan que la clave heredada
solo sirva para emitir el primer token de propietario y que un usuario normal no
pueda escalar a las rutas de administración.
"""

from __future__ import annotations

import db
from conftest import auth
from security import SCOPE_ADMIN, SCOPE_EXECUTE, SCOPE_READ

CLAVE_HEREDADA = "clave-heredada-de-prueba"


class TestArranque:
    def test_la_clave_heredada_emite_el_primer_token_de_propietario(self, client):
        res = client.post(
            "/admin/tokens",
            json={"user_email": "owner@aurum.test", "role": "owner", "scopes": [SCOPE_READ, SCOPE_ADMIN]},
            headers=auth(CLAVE_HEREDADA),
        )

        assert res.status_code == 200
        cuerpo = res.json()
        assert cuerpo["token"]
        # El token emitido funciona de verdad.
        assert db.authenticate(cuerpo["token"]).is_owner

    def test_el_primer_token_tiene_que_ser_de_propietario(self, client):
        res = client.post(
            "/admin/tokens",
            json={"user_email": "alguien@aurum.test", "role": "user"},
            headers=auth(CLAVE_HEREDADA),
        )
        assert res.status_code == 400
        assert db.count_tokens() == 0

    def test_la_clave_heredada_caduca_en_cuanto_existe_un_token(self, client, owner):
        res = client.post(
            "/admin/tokens",
            json={"user_email": "otro@aurum.test", "role": "owner"},
            headers=auth(CLAVE_HEREDADA),
        )
        assert res.status_code == 401

    def test_una_clave_heredada_incorrecta_no_abre_nada(self, client):
        res = client.post(
            "/admin/tokens",
            json={"user_email": "intruso@aurum.test", "role": "owner"},
            headers=auth("no-es-la-clave"),
        )
        assert res.status_code == 401
        assert db.count_tokens() == 0


class TestIdentidad:
    def test_sin_token_no_se_responde(self, client):
        assert client.get("/me").status_code == 401
        assert client.get("/me", headers=auth("inventado")).status_code == 401

    def test_me_describe_lo_que_permite_el_token(self, client, usuario):
        res = client.get("/me", headers=auth(usuario["token"]))
        assert res.status_code == 200

        cuerpo = res.json()
        assert cuerpo["user_email"] == "usuario@aurum.test"
        assert cuerpo["role"] == "user"
        assert cuerpo["scopes"] == [SCOPE_READ]
        assert cuerpo["broker_linked"] is False
        # La ejecución de órdenes viene desactivada por defecto.
        assert cuerpo["trading_enabled"] is False
        assert cuerpo["max_daily_eur"] == 1000
        assert cuerpo["executed_today_eur"] == 0.0

    def test_refleja_el_consumo_del_dia(self, client, usuario):
        db.record_order("o1", "k1", "usuario@aurum.test", "buy", "ISIN1", 250.0, "executed")
        assert client.get("/me", headers=auth(usuario["token"])).json()["executed_today_eur"] == 250.0


class TestAdministracion:
    def test_solo_el_propietario_emite_tokens(self, client, usuario):
        res = client.post(
            "/admin/tokens",
            json={"user_email": "colado@aurum.test", "role": "user"},
            headers=auth(usuario["token"]),
        )
        # Al usuario le falta el ámbito 'admin' antes incluso de mirar el rol.
        assert res.status_code == 403
        assert db.count_tokens() == 1

    def test_un_token_con_admin_pero_sin_rol_owner_tampoco_emite(self, client):
        token, _ = db.create_token("gestor@aurum.test", role="user", scopes=[SCOPE_READ, SCOPE_ADMIN])
        res = client.post("/admin/tokens", json={"user_email": "x@aurum.test"}, headers=auth(token))
        assert res.status_code == 403

    def test_el_propietario_emite_y_el_token_nuevo_funciona(self, client, owner):
        res = client.post(
            "/admin/tokens",
            json={"user_email": "nuevo@aurum.test", "role": "user", "scopes": [SCOPE_READ], "label": "móvil"},
            headers=auth(owner["token"]),
        )
        assert res.status_code == 200

        emitido = res.json()["token"]
        me = client.get("/me", headers=auth(emitido))
        assert me.json()["user_email"] == "nuevo@aurum.test"
        assert me.json()["role"] == "user"

    def test_rechaza_ambitos_desconocidos_en_lugar_de_ignorarlos(self, client, owner):
        res = client.post(
            "/admin/tokens",
            json={"user_email": "nuevo@aurum.test", "scopes": [SCOPE_READ, "superusuario"]},
            headers=auth(owner["token"]),
        )
        assert res.status_code == 400
        assert "superusuario" in res.json()["detail"]

    def test_listado_y_revocacion_son_solo_del_propietario(self, client, owner, usuario):
        assert client.get("/admin/tokens", headers=auth(usuario["token"])).status_code == 403
        assert client.delete(f"/admin/tokens/{owner['id']}", headers=auth(usuario["token"])).status_code == 403

        listado = client.get("/admin/tokens", headers=auth(owner["token"]))
        assert listado.status_code == 200
        assert {t["user_email"] for t in listado.json()["tokens"]} == {"owner@aurum.test", "usuario@aurum.test"}

    def test_revocar_deja_el_token_inservible_de_inmediato(self, client, owner, usuario):
        assert client.get("/me", headers=auth(usuario["token"])).status_code == 200

        res = client.delete(f"/admin/tokens/{usuario['id']}", headers=auth(owner["token"]))
        assert res.status_code == 200
        assert res.json() == {"revoked": True}

        assert client.get("/me", headers=auth(usuario["token"])).status_code == 401

    def test_la_auditoria_es_solo_del_propietario(self, client, owner, usuario):
        assert client.get("/admin/audit", headers=auth(usuario["token"])).status_code == 403

        res = client.get("/admin/audit", headers=auth(owner["token"]))
        assert res.status_code == 200
        assert any(e["event"] == "token_created" for e in res.json()["entries"])


class TestCredencialesDeBroker:
    CREDENCIALES = {"phone": "+34600000001", "pin": "1234"}

    def test_se_guardan_cifradas_y_no_se_devuelven_nunca(self, client, usuario):
        res = client.put("/broker/credentials", json=self.CREDENCIALES, headers=auth(usuario["token"]))
        assert res.status_code == 200
        assert res.json() == {"stored": True, "user_email": "usuario@aurum.test"}
        # Ni el PIN ni el teléfono vuelven en la respuesta.
        assert "1234" not in res.text
        assert "+34600000001" not in res.text

        estado = client.get("/broker/credentials", headers=auth(usuario["token"]))
        assert estado.json() == {"linked": True, "authenticated": False}
        assert "1234" not in estado.text

    def test_cada_usuario_guarda_las_suyas(self, client, owner, usuario):
        client.put("/broker/credentials", json=self.CREDENCIALES, headers=auth(usuario["token"]))

        assert client.get("/broker/credentials", headers=auth(owner["token"])).json()["linked"] is False
        assert db.get_broker_credentials("usuario@aurum.test").pin == "1234"
        assert db.get_broker_credentials("owner@aurum.test") is None

    def test_se_pueden_borrar(self, client, usuario):
        client.put("/broker/credentials", json=self.CREDENCIALES, headers=auth(usuario["token"]))

        assert client.delete("/broker/credentials", headers=auth(usuario["token"])).status_code == 200
        assert client.get("/broker/credentials", headers=auth(usuario["token"])).json()["linked"] is False

    def test_sin_cifrado_configurado_falla_en_vez_de_guardar_en_claro(self, client, usuario, monkeypatch):
        monkeypatch.setenv("AURUM_SECRET_KEY", "")
        res = client.put("/broker/credentials", json=self.CREDENCIALES, headers=auth(usuario["token"]))

        assert res.status_code == 503
        assert db.has_broker_credentials("usuario@aurum.test") is False

    def test_valida_la_forma_de_las_credenciales(self, client, usuario):
        assert client.put("/broker/credentials", json={"phone": "corto", "pin": "1234"}, headers=auth(usuario["token"])).status_code == 422
        assert client.put("/broker/credentials", json={"phone": "+34600000001", "pin": "1"}, headers=auth(usuario["token"])).status_code == 422

    def test_sin_token_no_se_llega(self, client):
        assert client.put("/broker/credentials", json=self.CREDENCIALES).status_code == 401
        assert client.get("/broker/credentials").status_code == 401


class TestTokenDeSoloLectura:
    """El contrato del token que los instaladores ponen en la aplicación.

    Ese token acaba en el navegador —es la propia página quien llama al backend—
    así que se emite con `read` y nada más. Estas pruebas fijan las dos mitades
    del trato: que llega a todo lo que la aplicación necesita de verdad, y que no
    llega a nada que mueva dinero ni toque el PC.
    """

    RUTAS_QUE_NECESITA = [
        ("get",  "/me",         None),
        ("get",  "/portfolio",  None),
        ("get",  "/auto-log",   None),
        ("post", "/auth/init",  {}),
    ]

    # Los cuerpos son válidos a propósito: con uno incompleto la respuesta sería
    # un 422 de validación y la prueba pasaría sin llegar a mirar el ámbito.
    _COMPRA = {"ticker": "AAPL", "isin": "US0378331005", "amount": 10.0, "name": "Apple"}

    RUTAS_VEDADAS = [
        ("post", "/invest",       {"trades": [_COMPRA]}),
        ("post", "/sell",         {"trades": [{"ticker": "AAPL", "isin": "US0378331005", "amount": 10.0}]}),
        ("post", "/run-now",      {}),
        ("post", "/schedule",     {"enabled": True}),
        ("post", "/do",           {"command": "ls"}),
        ("get",  "/agent/status", None),
    ]

    def test_alcanza_lo_que_la_aplicacion_usa(self, client, usuario):
        for metodo, ruta, cuerpo in self.RUTAS_QUE_NECESITA:
            res = (client.get(ruta, headers=auth(usuario["token"])) if cuerpo is None
                   else client.post(ruta, json=cuerpo, headers=auth(usuario["token"])))
            # Puede fallar por otras razones (sin broker enlazado, cuerpo
            # incompleto): lo que se afirma es que el ámbito no lo bloquea.
            assert res.status_code != 403, f"{ruta} rechazada por ámbito"

    def test_no_alcanza_nada_que_escriba(self, client, usuario):
        for metodo, ruta, cuerpo in self.RUTAS_VEDADAS:
            res = (client.get(ruta, headers=auth(usuario["token"])) if cuerpo is None
                   else client.post(ruta, json=cuerpo, headers=auth(usuario["token"])))
            assert res.status_code == 403, f"{ruta} debería exigir más ámbito"

    def test_no_puede_emitirse_a_si_mismo_mas_permisos(self, client, usuario):
        res = client.post(
            "/admin/tokens",
            json={"user_email": usuario["email"], "role": "owner", "scopes": [SCOPE_EXECUTE, SCOPE_ADMIN]},
            headers=auth(usuario["token"]),
        )
        assert res.status_code == 403
