"""
AURUM Backend — Trade Republic execution server.
Corre en un LXC de Proxmox, accesible vía Tailscale.

Novedades v2:
  - /auto-run: AURUM decide y ejecuta autónomamente (sin confirmación del usuario)
  - /schedule: configura el cron job autónomo en el servidor
  - Notificaciones Telegram opcionales
  - Scheduler interno con APScheduler
"""

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from tr_client import TRAuthError, TRClient, TROrderError

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

API_KEY          = os.getenv("AURUM_API_KEY", "")
TR_PHONE         = os.getenv("TR_PHONE", "")
TR_PIN           = os.getenv("TR_PIN", "")
TELEGRAM_TOKEN   = os.getenv("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
ANTHROPIC_KEY    = os.getenv("ANTHROPIC_API_KEY", "")

tr = TRClient()

# ── Telegram helper ──────────────────────────────────────────────────────────

async def telegram_notify(text: str) -> None:
    """Envía un mensaje al usuario vía Telegram si está configurado."""
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(url, json={
                "chat_id":    TELEGRAM_CHAT_ID,
                "text":       text,
                "parse_mode": "Markdown",
            })
        logger.info("Telegram notificado.")
    except Exception as e:
        logger.warning(f"Telegram error: {e}")


# ── Auth helper ──────────────────────────────────────────────────────────────

def require_key(x_aurum_key: str = Header(default="")) -> None:
    if not API_KEY:
        raise HTTPException(500, "AURUM_API_KEY no configurada en el servidor")
    if x_aurum_key != API_KEY:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "API key inválida")


# ── Autonomous scheduler ─────────────────────────────────────────────────────

_schedule_task: Optional[asyncio.Task] = None
_auto_cfg: dict = {
    "enabled":         False,
    "interval_hours":  168,   # 1 semana por defecto
    "max_amount":      100.0,
    "last_run":        None,
}

async def _run_auto_cycle():
    """
    Ciclo autónomo del servidor:
      1. Comprueba que TR esté autenticado
      2. Obtiene cartera actual
      3. Llama al endpoint /auto-run internamente
    """
    while True:
        await asyncio.sleep(3600)  # revisar cada hora
        if not _auto_cfg["enabled"]:
            continue
        if not tr.authenticated:
            logger.info("[Auto] TR no autenticado — saltando ciclo")
            continue

        interval_h = _auto_cfg.get("interval_hours", 168)
        last_run   = _auto_cfg.get("last_run")
        if last_run:
            elapsed_h = (datetime.now() - last_run).total_seconds() / 3600
            if elapsed_h < interval_h:
                continue

        logger.info("[Auto] Iniciando ciclo autónomo de inversión…")
        try:
            await tr.ensure_connected()
            positions = await tr.get_portfolio()
            cash      = await tr.get_cash()
            budget    = min(_auto_cfg["max_amount"], cash)

            if budget < 10:
                logger.info(f"[Auto] Saldo insuficiente ({cash:.2f}€) — no hay nada que invertir")
                await telegram_notify(f"⚠️ AURUM Auto: saldo insuficiente ({cash:.2f}€). Recarga tu cuenta de TR.")
                continue

            # La decisión de inversión la toma el frontend via /auto-run
            # El backend solo notifica que hay saldo disponible
            _auto_cfg["last_run"] = datetime.now()
            logger.info(f"[Auto] Saldo disponible: {cash:.2f}€. Listo para auto-inversión.")
            await telegram_notify(
                f"🤖 *AURUM Auto-monitor*\nSaldo disponible: *{cash:.2f}€*\n"
                f"Posiciones activas: {len(positions)}\n"
                f"Próximo ciclo en {interval_h}h"
            )
        except Exception as e:
            logger.error(f"[Auto] Error en ciclo: {e}")
            await telegram_notify(f"❌ AURUM Auto error: {e}")


# ── App lifecycle ────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _schedule_task
    logger.info("AURUM Backend v2 arrancando…")

    if TR_PHONE and TR_PIN:
        try:
            await tr.login_init(TR_PHONE, TR_PIN)
            logger.info("OTP enviado a tu teléfono TR. Usa POST /auth/verify para completar.")
        except Exception as e:
            logger.warning(f"Auto-login no pudo iniciar: {e}")

    _schedule_task = asyncio.create_task(_run_auto_cycle())
    logger.info("Scheduler autónomo iniciado.")
    await telegram_notify("✅ *AURUM Backend* arrancado y listo.")

    yield

    _schedule_task.cancel()
    await tr.disconnect()
    logger.info("AURUM Backend apagado.")
    await telegram_notify("🔴 *AURUM Backend* apagado.")


app = FastAPI(title="AURUM Backend", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
    amount: float
    name:   str

class InvestRequest(BaseModel):
    trades: list[TradeItem]

class AutoRunRequest(BaseModel):
    trades:   list[TradeItem]
    reasoning: str = ""
    notify:   bool = True   # enviar Telegram

class ScheduleConfig(BaseModel):
    enabled:        bool
    interval_hours: int   = 168
    max_amount:     float = 100.0


# ── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status":           "ok",
        "tr_authenticated": tr.authenticated,
        "tr_connected":     bool(tr._ws and tr._ws.open) if tr._ws else False,
        "auto_enabled":     _auto_cfg["enabled"],
        "auto_last_run":    _auto_cfg["last_run"].isoformat() if _auto_cfg.get("last_run") else None,
    }


@app.post("/auth/init")
async def auth_init(body: AuthInitRequest, x_aurum_key: str = Header(default="")):
    require_key(x_aurum_key)
    try:
        process_id = await tr.login_init(body.phone, body.pin)
        return {"status": "otp_sent", "processId": process_id}
    except TRAuthError as e:
        raise HTTPException(400, str(e))


@app.post("/auth/verify")
async def auth_verify(body: AuthVerifyRequest, x_aurum_key: str = Header(default="")):
    require_key(x_aurum_key)
    try:
        await tr.login_verify(body.otp)
        await tr.connect()
        await telegram_notify("✅ *Trade Republic autenticado*. AURUM puede ejecutar órdenes.")
        return {"status": "authenticated"}
    except TRAuthError as e:
        raise HTTPException(400, str(e))


@app.get("/portfolio")
async def get_portfolio(x_aurum_key: str = Header(default="")):
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
    """Ejecuta órdenes de compra (con confirmación del usuario)."""
    require_key(x_aurum_key)
    if not tr.authenticated:
        raise HTTPException(401, "No autenticado en Trade Republic")
    if not body.trades:
        raise HTTPException(400, "Lista de trades vacía")

    await tr.ensure_connected()
    results = []
    for trade in body.trades:
        try:
            logger.info(f"Ejecutando: {trade.amount}€ de {trade.ticker}")
            order_data = await tr.buy_cash_amount(trade.isin, trade.amount)
            results.append({
                "ticker": trade.ticker, "isin": trade.isin, "amount": trade.amount,
                "status": "executed",   "orderId": order_data.get("id", ""),
            })
        except (TROrderError, Exception) as e:
            logger.error(f"Error orden {trade.ticker}: {e}")
            results.append({"ticker": trade.ticker, "isin": trade.isin, "amount": trade.amount, "status": "error", "error": str(e)})

    executed = sum(1 for r in results if r["status"] == "executed")
    total_eur = sum(t.amount for t in body.trades if any(r["ticker"] == t.ticker and r["status"] == "executed" for r in results))

    if executed:
        trades_txt = "\n".join(f"  • {r['ticker']}: {next((t.amount for t in body.trades if t.ticker==r['ticker']),0):.0f}€" for r in results if r["status"]=="executed")
        await telegram_notify(f"✅ *AURUM ejecutó {executed} orden(es)* (usuario aprobó)\n{trades_txt}\nTotal: *{total_eur:.0f}€*")

    return {"results": results, "total_executed": executed, "total_trades": len(results)}


@app.post("/auto-run")
async def auto_run(body: AutoRunRequest, x_aurum_key: str = Header(default="")):
    """
    AURUM decide y ejecuta sin confirmación del usuario.
    Solo disponible si el usuario ha activado el modo autónomo.
    Requiere: tr autenticado + API key válida.
    """
    require_key(x_aurum_key)
    if not tr.authenticated:
        raise HTTPException(401, "No autenticado en Trade Republic")
    if not _auto_cfg["enabled"]:
        raise HTTPException(403, "Modo autónomo no activado. Actívalo en Ajustes.")
    if not body.trades:
        return {"results": [], "message": "AURUM decidió no invertir en este ciclo."}

    await tr.ensure_connected()
    results = []
    for trade in body.trades:
        try:
            logger.info(f"[AUTO] Ejecutando: {trade.amount}€ de {trade.ticker}")
            order_data = await tr.buy_cash_amount(trade.isin, trade.amount)
            results.append({
                "ticker": trade.ticker, "isin": trade.isin, "amount": trade.amount,
                "status": "executed",   "orderId": order_data.get("id", ""),
            })
        except Exception as e:
            logger.error(f"[AUTO] Error {trade.ticker}: {e}")
            results.append({"ticker": trade.ticker, "isin": trade.isin, "amount": trade.amount, "status": "error", "error": str(e)})

    executed   = sum(1 for r in results if r["status"] == "executed")
    total_eur  = sum(t.amount for t in body.trades if any(r["ticker"]==t.ticker and r["status"]=="executed" for r in results))
    _auto_cfg["last_run"] = datetime.now()

    if body.notify:
        if executed:
            trades_txt = "\n".join(f"  • {r['ticker']}: {next((t.amount for t in body.trades if t.ticker==r['ticker']),0):.0f}€" for r in results if r["status"]=="executed")
            await telegram_notify(
                f"🤖 *AURUM ejecutó autónomamente {executed} orden(es)*\n"
                f"{trades_txt}\n"
                f"Total: *{total_eur:.0f}€*\n\n"
                f"_{body.reasoning}_"
            )
        else:
            await telegram_notify(f"⚠️ *AURUM auto-run*: todas las órdenes fallaron.\n_{body.reasoning}_")

    return {"results": results, "total_executed": executed, "total_trades": len(results), "autonomous": True}


@app.post("/schedule")
async def configure_schedule(body: ScheduleConfig, x_aurum_key: str = Header(default="")):
    """Configura el modo autónomo del backend (desde el frontend)."""
    require_key(x_aurum_key)
    _auto_cfg.update({
        "enabled":        body.enabled,
        "interval_hours": body.interval_hours,
        "max_amount":     body.max_amount,
    })
    status_str = "activado" if body.enabled else "desactivado"
    logger.info(f"Schedule {status_str}: intervalo={body.interval_hours}h, máx={body.max_amount}€")
    if body.enabled:
        await telegram_notify(
            f"⚙️ *AURUM modo autónomo {status_str}*\n"
            f"Intervalo: cada {body.interval_hours}h\n"
            f"Presupuesto máximo: {body.max_amount:.0f}€/ciclo"
        )
    return {"status": "ok", "auto_enabled": _auto_cfg["enabled"]}


@app.post("/notify")
async def manual_notify(body: dict, x_aurum_key: str = Header(default="")):
    """Envía un mensaje personalizado al Telegram del usuario."""
    require_key(x_aurum_key)
    msg = body.get("message", "")
    if msg:
        await telegram_notify(msg)
    return {"status": "sent"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
