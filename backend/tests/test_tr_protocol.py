"""
Protocolo del WebSocket de Trade Republic.

Aquí no se prueba el broker: se prueba que hablamos su idioma. El cliente daba
por hecho que todo era JSON, y no lo es — los mensajes llevan un prefijo de
texto. El saludo equivocado no daba error: TR sencillamente no contestaba, y el
fallo aparecía después, al parsear cualquier otra cosa que llegara. Estas
pruebas fijan la forma real, comprobada contra el servidor.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from tr_client import TRAuthError, TRClient, TROrderError


class WSFalso:
    """Un WebSocket de mentira que devuelve las tramas que se le den."""

    def __init__(self, tramas: list[str]):
        self.tramas = list(tramas)
        self.enviado: list[str] = []
        self.open = True

    async def send(self, mensaje: str) -> None:
        self.enviado.append(mensaje)

    async def recv(self) -> str:
        if not self.tramas:
            await asyncio.sleep(3600)  # se queda esperando, como el de verdad
        return self.tramas.pop(0)


def cliente_con(tramas: list[str]) -> tuple[TRClient, WSFalso]:
    tr = TRClient()
    ws = WSFalso(tramas)
    tr._ws = ws
    return tr, ws


class TestSaludo:
    def test_el_saludo_va_con_prefijo_de_texto_y_no_como_json(self, monkeypatch):
        ws = WSFalso(["connected"])
        monkeypatch.setattr("tr_client.websockets.connect", lambda *a, **k: _envolver(ws))

        tr = TRClient()
        asyncio.run(tr._open_ws())

        assert len(ws.enviado) == 1
        saludo = ws.enviado[0]
        # La forma correcta: `connect <version> {json}`. Un objeto JSON suelto
        # con {"type": "connect"} no lo contesta nadie.
        assert saludo.startswith("connect ")
        cabecera, _, cuerpo = saludo.split(" ", 2)
        assert cabecera == "connect"
        assert json.loads(cuerpo)["clientId"] == "app.traderepublic.com"

    def test_la_respuesta_es_la_palabra_connected_no_un_objeto(self, monkeypatch):
        """`json.loads("connected")` reventaría: la respuesta no es JSON."""
        ws = WSFalso(["connected"])
        monkeypatch.setattr("tr_client.websockets.connect", lambda *a, **k: _envolver(ws))
        tr = TRClient()
        asyncio.run(tr._open_ws())  # no lanza

    def test_un_saludo_rechazado_se_dice_claro(self, monkeypatch):
        ws = WSFalso(["nope"])
        monkeypatch.setattr("tr_client.websockets.connect", lambda *a, **k: _envolver(ws))
        tr = TRClient()
        with pytest.raises(TRAuthError, match="saludo"):
            asyncio.run(tr._open_ws())


async def _envolver(ws):
    return ws


class TestTramas:
    def test_una_respuesta_completa_se_devuelve_parseada(self):
        tr, _ = cliente_con(['1 A {"processId":"abc123"}'])
        assert asyncio.run(tr._recv_for("1")) == {"processId": "abc123"}

    def test_la_letra_del_codigo_no_entra_en_el_json(self):
        """El fallo original: se parseaba desde la letra, no desde la carga."""
        tr, _ = cliente_con(['7 A [1,2,3]'])
        assert asyncio.run(tr._recv_for("7")) == [1, 2, 3]

    def test_los_echos_de_mantenimiento_se_ignoran(self):
        tr, _ = cliente_con(["echo 1755712345", '2 A {"ok":true}'])
        assert asyncio.run(tr._recv_for("2")) == {"ok": True}

    def test_las_tramas_de_otra_suscripcion_se_ignoran(self):
        tr, _ = cliente_con(['9 A {"otra":1}', '3 A {"mia":1}'])
        assert asyncio.run(tr._recv_for("3")) == {"mia": 1}

    def test_un_parche_no_se_confunde_con_la_respuesta(self):
        tr, _ = cliente_con(['4 D =patch', '4 A {"final":true}'])
        assert asyncio.run(tr._recv_for("4")) == {"final": True}

    def test_un_error_se_convierte_en_excepcion(self):
        tr, _ = cliente_con(['5 E {"errors":[{"errorCode":"VALIDATION_CODE_INVALID"}]}'])
        with pytest.raises(TROrderError, match="VALIDATION_CODE_INVALID"):
            asyncio.run(tr._recv_for("5"))

    def test_un_cierre_sin_respuesta_no_se_queda_colgado(self):
        tr, _ = cliente_con(["6 C"])
        with pytest.raises(TRAuthError, match="cerrado"):
            asyncio.run(tr._recv_for("6"))

    def test_sin_respuesta_acaba_por_agotarse(self):
        tr, _ = cliente_con([])
        with pytest.raises((TimeoutError, asyncio.TimeoutError)):
            asyncio.run(tr._recv_for("1", timeout=0.2))
