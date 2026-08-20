"""
Trade Republic WebSocket client (protocolo móvil/Android).

Flujo de auth:
  1. Conectar WS a wss://api.traderepublic.com
  2. Saludo `connect 31 {json}` → responde la palabra "connected"
  3. sub login       → TR envía OTP al teléfono, devuelve processId
  4. sub tan         → verifica OTP, devuelve sessionToken
  5. sub auth        → autentica la sesión WS para subs de datos
"""

import asyncio
import json
import logging
from typing import Any, Optional

import websockets
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger(__name__)

WS_URL = "wss://api.traderepublic.com"

# Version del protocolo que se anuncia en el saludo. Comprobado contra el
# servidor real: 30 y 31 responden igual.
WS_VERSION = 31

WS_HEADERS = {
    "Origin":     "https://app.traderepublic.com",
    "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36",
}


class TRAuthError(Exception):
    pass

class TROrderError(Exception):
    pass


class TRClient:
    def __init__(self) -> None:
        self._ws: Optional[websockets.WebSocketClientProtocol] = None
        self._counter = 1
        self._session_token: Optional[str] = None
        self._process_id:    Optional[str] = None
        self.authenticated = False

    # ── WebSocket helpers ───────────────────────────────────────────────────

    async def _open_ws(self) -> None:
        """Abre el WebSocket y hace el saludo inicial.

        El protocolo de TR no es JSON puro: los mensajes llevan un prefijo de
        texto. El saludo es `connect <version> {json}` y la respuesta es la
        palabra `connected`, tal cual. Mandar un objeto JSON con
        `{"type": "connect"}` no da error — TR sencillamente no contesta, y el
        cliente se quedaba esperando o parseando lo que llegara despues.
        """
        self._ws = await websockets.connect(WS_URL, extra_headers=WS_HEADERS)
        self._counter = 1

        await self._ws.send(f"connect {WS_VERSION} " + json.dumps({
            "locale":          "es",
            "platformId":      "webApp",
            "platformVersion": "chrome - 125.0.0",
            "clientId":        "app.traderepublic.com",
            "clientVersion":   "3.151.3",
        }))

        ack = await asyncio.wait_for(self._ws.recv(), timeout=15)
        if ack != "connected":
            raise TRAuthError(f"El saludo del WebSocket ha fallado: {ack!r}")

    async def _sub(self, payload: dict) -> Any:
        if not self._ws:
            raise TRAuthError("WebSocket no conectado.")
        sub_id = str(self._counter)
        self._counter += 1
        await self._ws.send(f"sub {sub_id} {json.dumps(payload)}")
        return await self._recv_for(sub_id)

    async def _recv_for(self, sub_id: str, timeout: float = 20.0) -> Any:
        """Espera la respuesta de una suscripcion.

        Las tramas son `<id> <codigo> <carga>`, donde el codigo es una letra:
        A la respuesta completa, D un parche sobre la anterior, C el cierre y
        E un error. Ademas llegan `echo <marca>` de mantenimiento, que no van
        dirigidos a nadie. Antes se daba por hecho que todo lo que empezara por
        el identificador era JSON, asi que la letra acababa dentro del parseo.
        """
        deadline = asyncio.get_event_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                raise TimeoutError(f"Timeout esperando respuesta para sub {sub_id}")

            raw = await asyncio.wait_for(self._ws.recv(), timeout=remaining)
            partes = raw.split(" ", 2)
            if partes[0] != sub_id:
                continue  # de otra suscripcion, o un echo de mantenimiento

            codigo = partes[1] if len(partes) > 1 else ""
            carga  = partes[2] if len(partes) > 2 else ""

            if codigo == "E":
                raise TROrderError(carga or "error sin detalle")
            if codigo == "A":
                return json.loads(carga)
            if codigo == "C":
                raise TRAuthError(f"TR ha cerrado la suscripcion {sub_id} sin responder.")
            # D: un parche sobre una respuesta anterior. Aqui solo interesa la
            # primera respuesta completa, asi que se sigue esperando.

    # ── Authentication (vía WebSocket) ──────────────────────────────────────

    async def login_init(self, phone: str, pin: str) -> str:
        """
        Envía phone+PIN por WS. TR manda OTP al teléfono.
        Devuelve el processId.
        """
        if not self._ws or not self._ws.open:
            await self._open_ws()

        data = await self._sub({
            "type":        "login",
            "phoneNumber": phone,
            "pin":         pin,
        })
        logger.info(f"Login WS response: {data}")

        self._process_id = (
            data.get("processId")
            or data.get("id")
            or data.get("process_id")
        )
        if not self._process_id:
            raise TRAuthError(f"No se obtuvo processId: {data}")
        return self._process_id

    async def login_verify(self, otp: str) -> str:
        """
        Verifica el OTP por WS. Devuelve el sessionToken y autentica la sesión.
        """
        if not self._process_id:
            raise TRAuthError("Llama primero a login_init()")
        if not self._ws or not self._ws.open:
            raise TRAuthError("Sesión WS perdida. Reinicia el login.")

        data = await self._sub({
            "type":      "tan",
            "processId": self._process_id,
            "tan":       otp,
        })
        logger.info(f"TAN WS response: {data}")

        token = data.get("sessionToken") or data.get("token")
        if not token:
            raise TRAuthError(f"No se obtuvo sessionToken: {data}")

        self._session_token = token

        # Autenticar la sesión WS para subs de datos
        await self._sub({"type": "auth", "token": self._session_token})
        self.authenticated = True
        logger.info("Trade Republic autenticado por WS ✓")
        return token

    # ── WebSocket connection (para reconexión tras auth) ────────────────────

    async def connect(self) -> None:
        """Reconecta usando el session token guardado."""
        if not self._session_token:
            raise TRAuthError("Sin session token. Autentícate primero.")
        await self._open_ws()
        await self._sub({"type": "auth", "token": self._session_token})
        self.authenticated = True
        logger.info("Reconectado a Trade Republic ✓")

    # ── Portfolio ───────────────────────────────────────────────────────────

    async def get_portfolio(self) -> list[dict]:
        data = await self._sub({"type": "portfolio"})
        positions = []
        for item in data.get("positions", []):
            positions.append({
                "isin":          item.get("instrumentId", "").split(".")[0],
                "name":          item.get("instrument", {}).get("shortName", ""),
                "shares":        item.get("netSize", 0),
                "avg_price":     item.get("averageBuyIn", 0),
                "current_price": item.get("currentPrice", 0),
                "value":         item.get("netValue", 0),
                "pnl_pct":       item.get("returnPercent", 0),
            })
        return positions

    async def get_cash(self) -> float:
        data = await self._sub({"type": "cash"})
        return data.get("availableCash", 0)

    # ── Price ───────────────────────────────────────────────────────────────

    async def get_price(self, isin: str) -> float:
        data = await self._sub({"type": "ticker", "id": f"{isin}.EU"})
        return data.get("last", {}).get("price", 0)

    # ── Orders ──────────────────────────────────────────────────────────────

    async def buy_cash_amount(self, isin: str, amount_eur: float) -> dict:
        logger.info(f"Comprando {amount_eur}€ de {isin}…")
        data = await self._sub({
            "type": "createOrder",
            "order": {
                "type":         "market",
                "side":         "buy",
                "instrumentId": f"{isin}.EU",
                "cashAmount":   round(amount_eur, 2),
                "cashCurrency": "EUR",
            },
        })
        logger.info(f"Orden compra {isin}: {data}")
        return data

    async def sell_shares(self, isin: str, shares: float) -> dict:
        """Vende una cantidad exacta de acciones/participaciones."""
        logger.info(f"Vendiendo {shares} unidades de {isin}…")
        data = await self._sub({
            "type": "createOrder",
            "order": {
                "type":         "market",
                "side":         "sell",
                "instrumentId": f"{isin}.EU",
                "size":         round(shares, 6),
            },
        })
        logger.info(f"Orden venta {isin}: {data}")
        return data

    async def sell_cash_amount(self, isin: str, amount_eur: float) -> dict:
        """Vende un importe en euros de un instrumento (requiere conocer el precio actual)."""
        logger.info(f"Vendiendo {amount_eur}€ de {isin}…")
        # Obtener precio actual para calcular número de acciones
        price = await self.get_price(isin)
        if not price:
            raise TROrderError(f"No se pudo obtener precio de {isin}")
        shares = round(amount_eur / price, 6)
        return await self.sell_shares(isin, shares)

    # ── Lifecycle ───────────────────────────────────────────────────────────

    async def disconnect(self) -> None:
        if self._ws:
            await self._ws.close()
            self._ws = None
            self.authenticated = False

    async def ensure_connected(self) -> None:
        try:
            if self._ws and self._ws.open:
                return
        except Exception:
            pass
        if self._session_token:
            await self.connect()
        else:
            raise TRAuthError("No autenticado. Usa /auth/init + /auth/verify primero.")
