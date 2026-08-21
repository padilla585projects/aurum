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

from tr_client import TRAuthError, TROrderError, TRClient


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


class TestSesionCedida:
    """La sesión que el usuario copia de su navegador.

    Es la única vía que queda desde que TR puso su anti-bot delante de todos
    los puntos de acceso. Lo que se fija aquí es que acepte lo que la gente
    consiga copiar —el formato exacto no se le puede exigir a nadie— y que una
    sesión caducada se diga en vez de dejar la cartera en blanco.
    """

    def test_entiende_la_cabecera_cookie_entera(self):
        from tr_client import _parsear_galletas
        assert _parsear_galletas("tr_session=abc123; otra=xyz") == {"tr_session": "abc123", "otra": "xyz"}

    def test_entiende_la_linea_tal_como_la_copia_el_navegador(self):
        from tr_client import _parsear_galletas
        assert _parsear_galletas("Cookie: tr_session=abc123")["tr_session"] == "abc123"

    def test_entiende_el_valor_suelto(self):
        from tr_client import _parsear_galletas
        assert _parsear_galletas("abc123") == {"tr_session": "abc123"}

    def test_aguanta_comillas_y_espacios_de_mas(self):
        from tr_client import _parsear_galletas
        assert _parsear_galletas('  " tr_session = abc123 ; b=2 "  ') == {"tr_session": "abc123", "b": "2"}

    def test_una_sesion_valida_deja_el_cliente_listo(self):
        """Se valida leyendo la cuenta, que es lo que se va a usar después."""
        tr = TRClient()
        visto = {}

        async def abrir_falso(token=""):
            visto["cabeceras"] = tr._cabeceras_ws()

        async def sub_falso(carga):
            visto["tema"] = carga["type"]
            return {"availableCash": 100.0}

        tr._open_ws, tr._sub = abrir_falso, sub_falso
        asyncio.run(tr.usar_sesion("tr_session=abc123; tr_claims=def456"))

        assert tr.authenticated is True
        # Las galletas viajan en el saludo, que es de donde TR saca quién eres.
        assert "tr_session=abc123" in visto["cabeceras"]["Cookie"]
        assert "tr_claims=def456" in visto["cabeceras"]["Cookie"]
        assert visto["tema"] == "cash"

    def test_una_sesion_caducada_se_dice_con_todas_las_letras(self):
        tr = TRClient()

        async def abrir_falso(token=""):
            pass

        async def sub_falso(carga):
            raise TROrderError('{"errors":[{"errorCode":"AUTHENTICATION_ERROR"}]}')

        tr._open_ws, tr._sub = abrir_falso, sub_falso
        with pytest.raises(TRAuthError, match="caducado"):
            asyncio.run(tr.usar_sesion("tr_session=vieja"))
        assert tr.authenticated is False

    def test_pegar_cualquier_cosa_no_pasa_por_valido(self):
        tr = TRClient()
        with pytest.raises(TRAuthError, match="reconozco"):
            asyncio.run(tr.usar_sesion("   "))

    def test_renovar_avisa_cuando_la_sesion_ha_muerto(self):
        tr = TRClient()
        tr._galletas = {"tr_session": "abc"}
        tr.authenticated = True

        async def caido():
            raise TRAuthError("sin sesión")

        tr.ensure_connected = caido
        assert asyncio.run(tr.renovar_sesion()) is False
        assert tr.authenticated is False

    def test_renovar_confirma_cuando_sigue_viva(self):
        tr = TRClient()
        tr._galletas = {"tr_session": "abc"}

        async def conectado():
            pass

        async def sub_falso(carga):
            return {"availableCash": 10.0}

        tr.ensure_connected, tr._sub = conectado, sub_falso
        assert asyncio.run(tr.renovar_sesion()) is True

    def test_sin_sesion_no_se_dice_que_sigue_viva(self):
        assert asyncio.run(TRClient().renovar_sesion()) is False


class TestPegarComoSea:
    """Lo que la gente consigue copiar, no lo que sería cómodo recibir.

    Buscar una cabecera concreta entre cuarenta es donde se atasca cualquiera,
    así que se acepta también el «Copiar como cURL» del navegador, que es un
    clic derecho.
    """

    CURL = (
        "curl 'https://api.traderepublic.com/api/v1/auth/web/session' \\n"
        "  -H 'accept: application/json' \\n"
        "  -H 'cookie: tr_session=abc123; tr_claims=def456; aws-waf-token=ghi789' \\n"
        "  -H 'user-agent: Mozilla/5.0'"
    )

    def test_entiende_un_copiar_como_curl(self):
        from tr_client import _parsear_galletas
        assert _parsear_galletas(self.CURL) == {
            "tr_session": "abc123", "tr_claims": "def456", "aws-waf-token": "ghi789",
        }

    def test_entiende_el_curl_con_la_opcion_corta(self):
        from tr_client import _parsear_galletas
        crudo = "curl 'https://api.traderepublic.com/x' -b 'tr_session=abc; tr_device=xyz' --compressed"
        assert _parsear_galletas(crudo) == {"tr_session": "abc", "tr_device": "xyz"}

    def test_una_cabecera_partida_en_varias_lineas_se_recompone(self):
        from tr_client import _parsear_galletas
        assert _parsear_galletas("tr_session=abc;\n  tr_claims=def") == {"tr_session": "abc", "tr_claims": "def"}

    def test_sigue_valiendo_la_linea_cookie_a_secas(self):
        from tr_client import _parsear_galletas
        assert _parsear_galletas("Cookie: tr_session=abc; b=2") == {"tr_session": "abc", "b": "2"}
