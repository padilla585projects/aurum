"""
Acceso a Trade Republic por REST.

TR retiró el login del WebSocket y con él el SMS. Lo que se fija aquí es la
parte que no depende de tener una cuenta viva: a qué dirección se llama, qué
cabeceras van, cómo se decide si toca meter un código o esperar la aprobación
del móvil, y que los errores lleguen legibles en vez de como un 500 pelado.
"""

from __future__ import annotations

import asyncio

import httpx
import pytest

from tr_client import TRAuthError, TRClient


def cliente_con(manejador) -> TRClient:
    """Un TRClient cuyo tráfico HTTP lo atiende `manejador`."""
    tr = TRClient()
    tr._sesion_http = httpx.AsyncClient(
        base_url="https://api.traderepublic.com",
        headers=tr._cabeceras(),
        transport=httpx.MockTransport(manejador),
    )
    return tr


def respuesta(datos, codigo=200, galletas=None):
    cabeceras = {}
    if galletas:
        cabeceras = [("set-cookie", f"{k}={v}; Path=/") for k, v in galletas.items()]
    return httpx.Response(codigo, json=datos, headers=cabeceras)


class TestInicio:
    def test_llama_a_la_v2_con_las_cabeceras_que_exige(self):
        visto = {}

        def manejador(peticion: httpx.Request) -> httpx.Response:
            visto["url"] = str(peticion.url)
            visto["cabeceras"] = peticion.headers
            return respuesta({"processId": "p-1", "countdownInSeconds": 60})

        tr = cliente_con(manejador)
        asyncio.run(tr.login_init("+34600111222", "1234"))

        assert visto["url"].endswith("/api/v2/auth/web/login")
        # Sin estas TR contesta MISSING_REQUIRED_HEADER antes de mirar el cuerpo.
        assert visto["cabeceras"]["x-tr-app-version"]
        assert visto["cabeceras"]["x-tr-platform"] == "web-pro"
        assert visto["cabeceras"]["x-tr-device-info"]

    def test_un_autenticador_pide_codigo(self):
        tr = cliente_con(lambda p: respuesta(
            {"processId": "p-2", "requiredAction": "AUTHENTICATOR_VERIFICATION"}))
        assert asyncio.run(tr.login_init("+34600111222", "1234"))["needsCode"] is True

    def test_sin_autenticador_se_espera_la_aprobacion_del_movil(self):
        tr = cliente_con(lambda p: respuesta({"processId": "p-3", "requiredAction": "APP_CONFIRMATION"}))
        assert asyncio.run(tr.login_init("+34600111222", "1234"))["needsCode"] is False

    def test_el_motivo_del_rechazo_llega_legible(self):
        """TR devuelve el porqué; enterrarlo obliga a mirar el registro."""
        tr = cliente_con(lambda p: respuesta(
            {"errors": [{"errorCode": "NUMBER_INVALID", "errorMessage": "phoneNumber"}]}, 400))
        with pytest.raises(TRAuthError, match="phoneNumber"):
            asyncio.run(tr.login_init("x", "y"))

    def test_una_respuesta_sin_processId_no_se_da_por_buena(self):
        tr = cliente_con(lambda p: respuesta({"algo": "otra cosa"}))
        with pytest.raises(TRAuthError, match="processId"):
            asyncio.run(tr.login_init("+34600111222", "1234"))


class TestSegundoFactor:
    def test_con_codigo_va_al_endpoint_del_autenticador(self):
        visto = {}

        def manejador(peticion: httpx.Request) -> httpx.Response:
            visto["url"] = str(peticion.url)
            return respuesta({"ok": True}, galletas={"tr_session": "sesion-de-prueba"})

        tr = cliente_con(manejador)
        tr._process_id = "p-9"
        assert asyncio.run(tr.login_verify("123456")) == "sesion-de-prueba"
        assert visto["url"].endswith("/api/v2/auth/web/login/processes/p-9/authenticator-verification")

    def test_sin_codigo_se_sondea_hasta_que_apruebas(self):
        estados = ["PENDING", "PENDING", "CONFIRMED"]

        def manejador(peticion: httpx.Request) -> httpx.Response:
            return respuesta({"status": estados.pop(0)}, galletas={"tr_session": "sesion-de-prueba"})

        tr = cliente_con(manejador)
        tr._process_id = "p-9"
        assert asyncio.run(tr.login_verify()) == "sesion-de-prueba"
        assert estados == []

    def test_un_rechazo_desde_el_movil_se_dice_y_no_se_sigue_esperando(self):
        tr = cliente_con(lambda p: respuesta({"status": "REJECTED"}))
        tr._process_id = "p-9"
        with pytest.raises(TRAuthError, match="REJECTED"):
            asyncio.run(tr.login_verify())

    def test_sin_galleta_de_sesion_no_se_canta_victoria(self):
        """Antes bastaba con que no fallara; sin sesión no se puede leer nada."""
        tr = cliente_con(lambda p: respuesta({"status": "CONFIRMED"}))
        tr._process_id = "p-9"
        with pytest.raises(TRAuthError, match="galleta"):
            asyncio.run(tr.login_verify())
        assert tr.authenticated is False

    def test_verificar_sin_haber_empezado_se_avisa(self):
        tr = cliente_con(lambda p: respuesta({}))
        with pytest.raises(TRAuthError, match="login_init"):
            asyncio.run(tr.login_verify("123456"))
