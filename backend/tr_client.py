"""
Trade Republic WebSocket client (protocolo móvil/Android).

Flujo de auth:
  1. Conectar WS a wss://api.traderepublic.com
  2. Handshake JSON  → recibe "connected"
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
        """Abre el WebSocket y hace el handshake inicial."""
        self._ws = await websockets.connect(WS_URL, extra_headers=WS_HEADERS)
        self._counter = 1

        await self._ws.send(json.dumps({
            "type":          "connect",
            "locale":        "es",
            "platformId":    "webApp",
            "clientId":      "app.traderepublic.com",
            "clientVersion": "1.0.0",
        }))
        ack = json.loads(await self._ws.recv())
        if ack.get("type") != "connected":
            raise TRAuthError(f"WS handshake fallido: {ack}")

    async def _sub(self, payload: dict) -> Any:
        if not self._ws:
            raise TRAuthError("WebSocket no conectado.")
        sub_id = str(self._counter)
        self._counter += 1
        await self._ws.send(f"sub {sub_id} {json.dumps(payload)}")
        return await self._recv_for(sub_id)

    async def _recv_for(self, sub_id: str, timeout: float = 20.0) -> Any:
        deadline = asyncio.get_event_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                raise TimeoutError(f"Timeout esperando respuesta para sub {sub_id}")
            raw = await asyncio.wait_for(self._ws.recv(), timeout=remaining)
            if raw.startswith(f"{sub_id} E "):
                raise TROrderError(raw[len(sub_id)+3:])
            if raw.startswith(f"{sub_id} "):
                return json.loads(raw[len(sub_id)+1:])

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
        logger.info(f"Orden {isin}: {data}")
        return data

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
