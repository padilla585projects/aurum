"""
Trade Republic WebSocket client (unofficial API).
Implementa el protocolo que usa la webapp de TR en app.traderepublic.com.

Protocolo:
  - Conexión:    WS a wss://api.traderepublic.com
  - Suscripción: "sub <id> <json_payload>"
  - Respuesta:   "<id> <json_data>" o "<id> E <error>"
  - Authn:       REST para login/OTP + WS para conectar con el token
"""

import asyncio
import json
import logging
import os
from typing import Any, Optional

import httpx
import websockets
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger(__name__)

WS_URL   = "wss://api.traderepublic.com"
REST_URL = "https://api.traderepublic.com/api/v1"

HEADERS = {
    "Origin":     "https://app.traderepublic.com",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
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

    # ── Authentication (REST) ───────────────────────────────────────────────

    async def login_init(self, phone: str, pin: str) -> str:
        """Envía phone+PIN a TR. TR envía un OTP por SMS. Devuelve el processId."""
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{REST_URL}/auth/web/login",
                json={"phoneNumber": phone, "pin": pin},
                headers={"Content-Type": "application/json"},
            )
            if resp.status_code not in (200, 201):
                raise TRAuthError(f"Login fallido: {resp.status_code} {resp.text}")
            data = resp.json()
            self._process_id = data.get("processId") or data.get("id")
            if not self._process_id:
                raise TRAuthError(f"No se obtuvo processId: {data}")
            return self._process_id

    async def login_verify(self, otp: str) -> str:
        """Verifica el OTP. Devuelve el session token."""
        if not self._process_id:
            raise TRAuthError("Llama primero a login_init()")
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{REST_URL}/auth/web/login/{self._process_id}/tan",
                json={"tan": otp},
                headers={"Content-Type": "application/json"},
            )
            if resp.status_code not in (200, 201):
                raise TRAuthError(f"OTP inválido: {resp.status_code} {resp.text}")
            data = resp.json()
            token = data.get("sessionToken") or data.get("token")
            if not token:
                raise TRAuthError(f"No se obtuvo sessionToken: {data}")
            self._session_token = token
            return token

    # ── WebSocket connection ────────────────────────────────────────────────

    async def connect(self) -> None:
        """Establece la conexión WebSocket usando el session token."""
        if not self._session_token:
            raise TRAuthError("Sin session token. Autentícate primero.")

        self._ws = await websockets.connect(WS_URL, extra_headers=HEADERS)

        # Handshake inicial
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

        # Autenticar la sesión WebSocket
        self._counter = 1
        await self._sub({"type": "auth", "token": self._session_token})
        self.authenticated = True
        logger.info("Conectado a Trade Republic ✓")

    async def _sub(self, payload: dict) -> Any:
        """Envía una suscripción y espera la primera respuesta."""
        if not self._ws:
            raise TRAuthError("WebSocket no conectado.")
        sub_id = str(self._counter)
        self._counter += 1
        await self._ws.send(f"sub {sub_id} {json.dumps(payload)}")
        return await self._recv_for(sub_id)

    async def _recv_for(self, sub_id: str, timeout: float = 15.0) -> Any:
        """Lee mensajes hasta encontrar la respuesta para sub_id."""
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

    async def _unsub(self, sub_id: str) -> None:
        if self._ws:
            await self._ws.send(f"unsub {sub_id}")

    # ── Portfolio ───────────────────────────────────────────────────────────

    async def get_portfolio(self) -> list[dict]:
        """Devuelve las posiciones actuales de la cartera."""
        data = await self._sub({"type": "portfolio"})
        positions = []
        for item in data.get("positions", []):
            positions.append({
                "isin":         item.get("instrumentId", "").split(".")[0],
                "name":         item.get("instrument", {}).get("shortName", ""),
                "shares":       item.get("netSize", 0),
                "avg_price":    item.get("averageBuyIn", 0),
                "current_price":item.get("currentPrice", 0),
                "value":        item.get("netValue", 0),
                "pnl_pct":      item.get("returnPercent", 0),
            })
        return positions

    async def get_cash(self) -> float:
        """Devuelve el saldo disponible en EUR."""
        data = await self._sub({"type": "cash"})
        return data.get("availableCash", 0)

    # ── Price ───────────────────────────────────────────────────────────────

    async def get_price(self, isin: str) -> float:
        """Obtiene el último precio conocido de un instrumento."""
        data = await self._sub({"type": "ticker", "id": f"{isin}.EU"})
        return data.get("last", {}).get("price", 0)

    # ── Orders ──────────────────────────────────────────────────────────────

    async def buy_cash_amount(self, isin: str, amount_eur: float) -> dict:
        """
        Compra un instrumento por importe en EUR (fractional / cash-based order).
        TR lo soporta para ETFs y acciones fraccionarias.
        """
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
        """Reconecta si el WS se ha cerrado."""
        try:
            if self._ws and self._ws.open:
                return
        except Exception:
            pass
        await self.connect()
