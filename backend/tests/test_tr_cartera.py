"""
Lectura de la cartera después de que TR retirara el tema `portfolio`.

Lo que se fija aquí es la tolerancia: TR renombra campos sin avisar, y la
respuesta a un renombrado no puede ser devolver una cartera vacía, porque eso
se lee como «no tienes nada» y nadie se entera de que está roto. O sale bien, o
se dice qué llegó.
"""

from __future__ import annotations

import asyncio

import pytest

import tr_client
from tr_client import TRAuthError, TRClient, TROrderError


def cliente(respuestas: dict) -> TRClient:
    """Un TRClient cuyo `_sub` devuelve lo que se le diga, por tema."""
    tr = TRClient()

    async def sub_falso(carga):
        tema = carga["type"]
        if tema not in respuestas:
            raise TROrderError(f"Unknown topic type: {tema}")
        return respuestas[tema]

    tr._sub = sub_falso
    return tr


UNA_POSICION = {
    "instrumentId": "US0378331005.LSX",
    "shortName": "Apple",
    "netSize": "3",
    "averageBuyIn": "180.5",
    "currentPrice": "271.1",
    "netValue": "813.3",
    "returnPercent": "50.2",
}


class TestNumeroDeCuenta:
    def test_se_saca_de_accountPairs_aunque_venga_anidado(self):
        tr = cliente({"accountPairs": {"accounts": [{"securitiesAccountNumber": "12345678"}]}})
        assert asyncio.run(tr._numero_de_cuenta()) == "12345678"

    def test_se_recuerda_y_no_se_vuelve_a_pedir(self):
        llamadas = []

        async def sub_falso(carga):
            llamadas.append(carga["type"])
            return {"secAccNo": "999"}

        tr = TRClient()
        tr._sub = sub_falso
        assert asyncio.run(tr._numero_de_cuenta()) == "999"
        assert asyncio.run(tr._numero_de_cuenta()) == "999"
        assert llamadas == ["accountPairs"]

    def test_si_no_aparece_se_dice_que_llego(self):
        tr = cliente({"accountPairs": {"algo": "otra cosa"}})
        with pytest.raises(TRAuthError, match="algo"):
            asyncio.run(tr._numero_de_cuenta())


class TestCartera:
    def test_lee_una_posicion_con_los_nombres_de_hoy(self):
        tr = cliente({
            "accountPairs": {"secAccNo": "1"},
            "compactPortfolioByType": {"positions": [UNA_POSICION]},
        })
        pos = asyncio.run(tr.get_portfolio())
        assert len(pos) == 1
        assert pos[0]["isin"] == "US0378331005"   # sin el sufijo del mercado
        assert pos[0]["name"] == "Apple"
        assert pos[0]["shares"] == 3.0
        assert pos[0]["value"] == 813.3

    def test_lee_igual_si_las_posiciones_vienen_agrupadas_por_tipo(self):
        """`compactPortfolioByType` agrupa por producto: acciones, fondos…"""
        tr = cliente({
            "accountPairs": {"secAccNo": "1"},
            "compactPortfolioByType": {
                "categories": [
                    {"type": "stock", "positions": [UNA_POSICION]},
                    {"type": "fund", "positions": []},
                ]
            },
        })
        assert len(asyncio.run(tr.get_portfolio())) == 1

    def test_lee_igual_si_llega_una_lista_suelta(self):
        tr = cliente({"accountPairs": {"secAccNo": "1"}, "compactPortfolioByType": [UNA_POSICION]})
        assert len(asyncio.run(tr.get_portfolio())) == 1

    def test_acepta_nombres_alternativos_de_campo(self):
        tr = cliente({
            "accountPairs": {"secAccNo": "1"},
            "compactPortfolioByType": {"securities": [{
                "isin": "IE00B4L5Y983", "name": "iShares Core MSCI World",
                "size": 12, "averagePrice": 80.0, "lastPrice": 95.0, "marketValue": 1140.0,
            }]},
        })
        pos = asyncio.run(tr.get_portfolio())[0]
        assert pos["isin"] == "IE00B4L5Y983"
        assert pos["shares"] == 12.0
        assert pos["current_price"] == 95.0

    def test_una_forma_desconocida_no_se_confunde_con_cartera_vacia(self):
        tr = cliente({
            "accountPairs": {"secAccNo": "1"},
            "compactPortfolioByType": {"algoNuevo": "que no esperabamos"},
        })
        with pytest.raises(TROrderError, match="algoNuevo"):
            asyncio.run(tr.get_portfolio())

    def test_una_posicion_sin_isin_se_descarta_sin_tumbar_el_resto(self):
        tr = cliente({
            "accountPairs": {"secAccNo": "1"},
            "compactPortfolioByType": {"positions": [{"shortName": "rara"}, UNA_POSICION]},
        })
        assert len(asyncio.run(tr.get_portfolio())) == 1


class TestEfectivo:
    def test_lee_el_efectivo_del_tema_de_siempre(self):
        tr = cliente({"cash": {"availableCash": "1250.75"}})
        assert asyncio.run(tr.get_cash()) == 1250.75

    def test_si_el_primero_falla_prueba_los_siguientes(self):
        tr = cliente({"availableCash": {"amount": 42.0}})   # `cash` no responde
        assert asyncio.run(tr.get_cash()) == 42.0

    def test_lee_el_efectivo_aunque_venga_en_una_lista(self):
        tr = cliente({"cash": [{"currencyId": "EUR", "amount": "300.5"}]})
        assert asyncio.run(tr.get_cash()) == 300.5

    def test_sin_ninguna_fuente_devuelve_cero_en_vez_de_reventar(self):
        tr = cliente({})
        assert asyncio.run(tr.get_cash()) == 0.0


class TestUtilidades:
    def test_las_claves_recibidas_se_pueden_contar_en_el_error(self):
        assert tr_client._claves({"b": 1, "a": 2}) == ["a", "b"]
        assert "lista de 2" in tr_client._claves([{"x": 1}, {"y": 2}])
