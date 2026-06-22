"""
AURUM Backend — Trade Republic execution server.
Corre en un LXC de Proxmox, accesible vía Tailscale.
El frontend de AURUM llama a este servidor para ejecutar órdenes en TR.
"""

import logging
import os
from contextlib import asynccontextmanager
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from tr_client import TRAuthError, TRClient, TROrderError

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

API_KEY  = os.getenv("AURUM_API_KEY", "")
TR_PHONE = os.getenv("TR_PHONE", "")
TR_PIN   = os.getenv("TR_PIN", "")

tr = TRClient()


# ── Auth helper ─────────────────────────────────────────────────────────────

def require_key(x_aurum_key: str = Header(default="")) -> None:
    if not API_KEY:
        raise HTTPException(500, "AURUM_API_KEY no configurada en el servidor")
    if x_aurum_key != API_KEY:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "API key inválida")


# ── App ──────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("AURUM Backend arrancando…")
    # Auto-login si hay credenciales en .env
    if TR_PHONE and TR_PIN:
        try:
            logger.info("Auto-login con credenciales de .env — esperando OTP en tu teléfono…")
            await tr.login_init(TR_PHONE, TR_PIN)
            logger.info("OTP enviado. Usa POST /auth/verify para completar el login.")
        except Exception as e:
            logger.warning(f"Auto-login no pudo iniciar: {e}")
    yield
    await tr.disconnect()
    logger.info("AURUM Backend apagado.")


app = FastAPI(title="AURUM Backend", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # Solo accesible por Tailscale — no hay riesgo
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Pydantic models ──────────────────────────────────────────────────────────

class AuthInitRequest(BaseModel):
    phone: str
    pin:   str

class AuthVerifyRequest(BaseModel):
    otp: str

class TradeItem(BaseModel):
    ticker: str
    isin:   str
    amount: float   # euros
    name:   str

class InvestRequest(BaseModel):
    trades: list[TradeItem]


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """El frontend llama a esto para verificar que el backend está vivo."""
    return {
        "status":          "ok",
        "tr_authenticated": tr.authenticated,
        "tr_connected":     tr._ws is not None and tr._ws.open if tr._ws else False,
    }


@app.post("/auth/init")
async def auth_init(body: AuthInitRequest, x_aurum_key: str = Header(default="")):
    """Inicia el login en TR. TR envía un OTP al teléfono."""
    require_key(x_aurum_key)
    try:
        process_id = await tr.login_init(body.phone, body.pin)
        return {"status": "otp_sent", "processId": process_id}
    except TRAuthError as e:
        raise HTTPException(400, str(e))


@app.post("/auth/verify")
async def auth_verify(body: AuthVerifyRequest, x_aurum_key: str = Header(default="")):
    """Verifica el OTP y establece la sesión WebSocket con TR."""
    require_key(x_aurum_key)
    try:
        await tr.login_verify(body.otp)
        await tr.connect()
        return {"status": "authenticated"}
    except TRAuthError as e:
        raise HTTPException(400, str(e))


@app.get("/portfolio")
async def get_portfolio(x_aurum_key: str = Header(default="")):
    """Devuelve las posiciones actuales de TR."""
    require_key(x_aurum_key)
    if not tr.authenticated:
        raise HTTPException(401, "No autenticado en Trade Republic")
    try:
        await tr.ensure_connected()
        positions = await tr.get_portfolio()
        cash      = await tr.get_cash()
        return {"positions": positions, "cash": cash}
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/invest")
async def invest(body: InvestRequest, x_aurum_key: str = Header(default="")):
    """
    Ejecuta las órdenes de compra propuestas por AURUM.
    Se procesan en secuencia. Devuelve el estado de cada orden.
    """
    require_key(x_aurum_key)
    if not tr.authenticated:
        raise HTTPException(401, "No autenticado en Trade Republic")
    if not body.trades:
        raise HTTPException(400, "Lista de trades vacía")

    await tr.ensure_connected()

    results = []
    for trade in body.trades:
        try:
            logger.info(f"Ejecutando: {trade.amount}€ de {trade.ticker} ({trade.isin})")
            order_data = await tr.buy_cash_amount(trade.isin, trade.amount)
            results.append({
                "ticker":  trade.ticker,
                "isin":    trade.isin,
                "amount":  trade.amount,
                "status":  "executed",
                "orderId": order_data.get("id") or order_data.get("orderId", ""),
                "detail":  order_data,
            })
        except TROrderError as e:
            logger.error(f"Error en orden {trade.ticker}: {e}")
            results.append({
                "ticker": trade.ticker,
                "isin":   trade.isin,
                "amount": trade.amount,
                "status": "error",
                "error":  str(e),
            })
        except Exception as e:
            logger.error(f"Error inesperado {trade.ticker}: {e}")
            results.append({
                "ticker": trade.ticker,
                "isin":   trade.isin,
                "amount": trade.amount,
                "status": "error",
                "error":  str(e),
            })

    total_executed = sum(1 for r in results if r["status"] == "executed")
    return {
        "results":        results,
        "total_executed": total_executed,
        "total_trades":   len(results),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
