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
import hashlib
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from typing import Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Header, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from tr_client import TRAuthError, TRClient, TROrderError

import broker_sessions
import db
import endpoints_identity
from security import (
    ALL_SCOPES,
    SCOPE_ADMIN,
    SCOPE_EXECUTE,
    SCOPE_READ,
    Principal,
    secrets_available,
)

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

API_KEY          = os.getenv("AURUM_API_KEY", "")
TR_PHONE         = os.getenv("TR_PHONE", "")
TR_PIN           = os.getenv("TR_PIN", "")
TELEGRAM_TOKEN   = os.getenv("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
ANTHROPIC_KEY    = os.getenv("ANTHROPIC_API_KEY", "")

ALLOWED_ORIGINS = [
    origin.strip() for origin in os.getenv(
        "AURUM_ALLOWED_ORIGINS",
        "https://aurum-7cm.pages.dev,http://localhost:5173",
    ).split(",") if origin.strip()
]
MAX_TRADE_AMOUNT_EUR = 10_000.0

# Correo del propietario. Es la identidad bajo la que corre el ciclo autónomo y
# la sesión de broker que se crea con las credenciales del .env.
OWNER_EMAIL = os.getenv("AURUM_OWNER_EMAIL", "owner@aurum.local").strip().lower()

# Interruptor maestro de ejecución. Desactivado por defecto: mientras esté en
# false, AURUM analiza y propone, pero ninguna orden llega al broker. Solo debe
# activarse cuando el flujo de doble confirmación se haya probado a conciencia.
TRADING_ENABLED = os.getenv("AURUM_TRADING_ENABLED", "false").strip().lower() == "true"

# Límite diario acumulado por usuario, además del tope por orden.
MAX_DAILY_EUR = float(os.getenv("AURUM_MAX_DAILY_EUR", "1000"))

# ── Claude helper ────────────────────────────────────────────────────────────

async def _call_claude(system: str, user: str, max_tokens: int = 1024, web_search: bool = True) -> str:
    """Llama a Claude claude-sonnet-5 con búsqueda web opcional."""
    if not ANTHROPIC_KEY:
        raise ValueError("ANTHROPIC_API_KEY no configurada")
    body: dict = {
        "model":      "claude-sonnet-5",
        "max_tokens": max_tokens,
        "system":     system,
        "messages":   [{"role": "user", "content": user}],
    }
    if web_search:
        body["tools"] = [{"type": "web_search_20260209", "name": "web_search", "max_uses": 3}]

    headers = {
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta":    "interleaved-thinking-2025-05-14",
        "Content-Type":      "application/json",
    }
    async with httpx.AsyncClient(timeout=60) as client:
        for _ in range(8):
            r = await client.post("https://api.anthropic.com/v1/messages", headers=headers, json=body)
            r.raise_for_status()
            data = r.json()
            stop = data.get("stop_reason")
            if stop == "end_turn":
                return " ".join(
                    b["text"] for b in data.get("content", []) if b.get("type") == "text"
                ).strip()
            if stop == "tool_use" and web_search:
                body["messages"].append({"role": "assistant", "content": data["content"]})
                body["messages"].append({
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": b["id"], "content": "Executed"}
                        for b in data["content"] if b.get("type") == "tool_use"
                    ],
                })
            else:
                break
    return "Sin respuesta."

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

def require_key(x_aurum_key: str = Header(default="")) -> Principal:
    """
    Identifica al usuario a partir de su token personal.

    Sustituye a la clave única compartida: ahora cada persona tiene su propio
    token, con rol y ámbitos, revocable de forma independiente. La antigua
    AURUM_API_KEY solo sirve ya para una cosa —emitir el primer token de
    propietario— y deja de funcionar en cuanto existe alguno.
    """
    principal = db.authenticate(x_aurum_key)
    if principal is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Token inválido o revocado")
    return principal


def require_scope(principal: Principal, scope: str) -> None:
    if not principal.has(scope):
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"Tu token no tiene el permiso '{scope}' necesario para esta operación",
        )


def _bootstrap_key_valid(key: str) -> bool:
    """La clave heredada solo vale mientras no haya ningún token emitido."""
    return bool(API_KEY) and key == API_KEY and db.count_tokens() == 0


# ── Autonomous scheduler ─────────────────────────────────────────────────────

_schedule_task: Optional[asyncio.Task] = None
_auto_cfg: dict = {
    "enabled":         False,
    "interval_hours":  168,   # 1 semana por defecto
    "max_amount":      100.0,
    "last_run":        None,
    # ── Perfil del inversor (sincronizado desde el frontend) ──────────────
    "profile":         "moderado",
    "target_alloc":    "",          # ej: "70% renta variable, 20% bonos, 10% liquidez"
    "user_goals":      "",          # ej: "jubilación en 20 años, ahorro 500€/mes"
    # ── Log de ejecuciones autónomas ─────────────────────────────────────
    "action_log":      [],          # últimas 20 ejecuciones
}

# ── Triggers inteligentes ─────────────────────────────────────────────────────
# Umbrales para disparar el ciclo inmediatamente (sin esperar el intervalo)
_TRIGGER_CFG = {
    "market_drop_pct":  -3.0,   # SP500 cae >3% → comprar oportunidad
    "drift_threshold":   15.0,  # drift de cartera >15% → rebalancear ya
    "new_cash_min":      20.0,  # nuevo saldo disponible >20€ → invertir
}
_last_market_check: Optional[datetime] = None
_last_sp500_price:  Optional[float]    = None

_PROFILE_META = {
    "conservador": {
        "label":  "Conservador",
        "desc":   "Preservar capital. Tolerancia a pérdidas baja (máx -10%). Horizonte corto-medio.",
        "alloc":  "40% renta variable, 40% bonos/renta fija, 20% liquidez",
        "etfs":   "XEON (monetario), AGGU (bonos globales), EUNL (RV mundo), VHYL (dividendos)",
    },
    "moderado": {
        "label":  "Moderado",
        "desc":   "Crecimiento equilibrado. Tolerancia media (-20%). Horizonte 5-10 años.",
        "alloc":  "65% renta variable, 25% bonos, 10% alternativos/oro",
        "etfs":   "VWCE (mundo), SPPW (S&P500), EUNL (Europa), XEON (monetario), SGLN (oro)",
    },
    "agresivo": {
        "label":  "Agresivo",
        "desc":   "Maximizar rentabilidad a largo plazo. Alta tolerancia (-40%). Horizonte >10 años.",
        "alloc":  "90% renta variable (diversificada), 10% activos alternativos",
        "etfs":   "VWCE (mundo), SPPW (S&P500), ZPRV (small-cap value), IEMA (emergentes), QDVE (tech)",
    },
}

def _build_auto_system(profile: str, target_alloc: str = "", user_goals: str = "") -> str:
    pm = _PROFILE_META.get(profile, _PROFILE_META["moderado"])
    alloc = target_alloc or pm["alloc"]
    goals_block = f"\nOBJETIVOS DEL INVERSOR: {user_goals}" if user_goals else ""
    return f"""\
Eres AURUM, gestor de inversiones autónomo con plena autorización del usuario para ejecutar operaciones.
Usa búsqueda web para obtener datos de mercado en tiempo real antes de decidir.

PERFIL DEL INVERSOR: {pm["label"]} — {pm["desc"]}
ASIGNACIÓN OBJETIVO: {alloc}
ETFs PREFERIDOS PARA ESTE PERFIL: {pm["etfs"]}{goals_block}

MISIÓN: Analiza la cartera, el mercado actual y decide la mejor inversión para el presupuesto disponible.
Responde SOLO con JSON válido (sin texto adicional, sin backticks):
{{
  "action": "invest|rebalance|hold",
  "trades": [
    {{"ticker": "VWCE", "isin": "IE00B3RBWM25", "name": "Vanguard FTSE All-World", "amount": 80}}
  ],
  "reasoning": "2-3 frases explicando la decisión y contexto de mercado actual.",
  "marketBrief": "Una frase sobre el estado del mercado hoy.",
  "confidence": 0.85
}}

Si no es buen momento → {{"action": "hold", "reasoning": "motivo", "marketBrief": "contexto", "confidence": 0.5}}
Si hay drift de cartera → usa "rebalance" con trades que corrijan la asignación objetivo.

REGLAS:
- Los importes en trades deben sumar ≤ el presupuesto indicado.
- Máximo 4 instrumentos si presupuesto < 500€; hasta 6 si ≥ 500€.
- Solo instrumentos disponibles en Trade Republic España.
- No duplicar posiciones a menos que sea rebalanceo justificado.
- Mínimo 10€ por instrumento.
- Confidence < 0.7 → acción "hold" aunque haya oportunidad (más vale no actuar que actuar mal).
"""

def _log_action(entry: dict) -> None:
    """Añade una entrada al log de acciones autónomas (máx 50)."""
    log: list = _auto_cfg.get("action_log", [])
    log.append({**entry, "ts": datetime.now().isoformat()})
    _auto_cfg["action_log"] = log[-50:]


async def _check_smart_triggers() -> Optional[str]:
    """
    Comprueba si hay un evento de mercado que justifique ejecutar el ciclo ahora.
    Devuelve una razón de trigger, o None si no hay.
    """
    global _last_market_check, _last_sp500_price

    # No más de una comprobación cada 30 minutos
    if _last_market_check and (datetime.now() - _last_market_check).total_seconds() < 1800:
        return None
    _last_market_check = datetime.now()

    try:
        prices = await _yahoo_prices(["SP500"])
        sp500 = prices.get("SP500", 0)
        if not sp500:
            return None

        if _last_sp500_price and _last_sp500_price > 0:
            change_pct = (sp500 - _last_sp500_price) / _last_sp500_price * 100
            drop_threshold = _TRIGGER_CFG["market_drop_pct"]
            if change_pct <= drop_threshold:
                logger.info(f"[Trigger] Caída de mercado detectada: S&P500 {change_pct:+.1f}%")
                _last_sp500_price = sp500
                return f"Caída de mercado S&P500 {change_pct:+.1f}% — oportunidad de compra"

        _last_sp500_price = sp500
    except Exception as e:
        logger.debug(f"[Trigger] Error comprobando mercado: {e}")

    # Comprobar saldo disponible
    try:
        if tr.authenticated:
            await tr.ensure_connected()
            cash = await tr.get_cash()
            if cash >= _TRIGGER_CFG["new_cash_min"] and cash >= _auto_cfg["max_amount"] * 0.5:
                return f"Nuevo saldo disponible: {cash:.0f}€ — listo para invertir"
    except Exception:
        pass

    return None


async def _execute_auto_cycle(trigger_reason: str = "ciclo programado") -> dict:
    """
    Ciclo autónomo completo:
      1. Obtiene cartera y saldo de TR
      2. Llama a Claude (perfil del inversor) con web search para decidir
      3. Ejecuta las órdenes directamente en TR
      4. Notifica y loguea el resultado
    Devuelve un dict con el resultado del ciclo.
    """
    logger.info(f"[Auto] Iniciando ciclo — trigger: {trigger_reason}")

    await tr.ensure_connected()
    positions = await tr.get_portfolio()
    cash      = await tr.get_cash()
    budget    = min(_auto_cfg["max_amount"], cash)

    if budget < 10:
        logger.info(f"[Auto] Saldo insuficiente ({cash:.2f}€)")
        await telegram_notify(f"⚠️ *AURUM Auto*: saldo insuficiente (*{cash:.2f}€*). Recarga tu cuenta de TR.")
        return {"action": "hold", "reason": "saldo insuficiente", "executed": 0}

    # Construir contexto de cartera
    portfolio_lines = "\n".join(
        f"  {p.get('name','?')}: {p.get('value',0):.0f}€ ({p.get('pnl_pct',0):+.1f}%)"
        for p in positions
    ) or "  (cartera vacía)"
    total_val = sum(p.get("value", 0) for p in positions)

    # Calcular drift aproximado respecto a asignación objetivo
    profile      = _auto_cfg.get("profile", "moderado")
    target_alloc = _auto_cfg.get("target_alloc", "")
    user_goals   = _auto_cfg.get("user_goals", "")

    user_msg = (
        f"Ciclo autónomo — {datetime.now().strftime('%d/%m/%Y %H:%M')}\n"
        f"Trigger: {trigger_reason}\n"
        f"Presupuesto disponible: {budget:.2f}€\n"
        f"Valor total cartera: {total_val:.0f}€\n"
        f"Posiciones actuales:\n{portfolio_lines}\n\n"
        f"1. Consulta el estado actual del mercado con búsqueda web.\n"
        f"2. Analiza si la cartera está desalineada con el objetivo.\n"
        f"3. Decide la mejor inversión para {budget:.0f}€ dado el contexto."
    )

    logger.info(f"[Auto] Llamando a Claude (perfil={profile}) para decidir inversión de {budget:.0f}€…")
    system = _build_auto_system(profile, target_alloc, user_goals)
    raw    = await _call_claude(system, user_msg, max_tokens=1024, web_search=True)

    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        raise ValueError(f"Claude no devolvió JSON válido: {raw[:200]}")
    plan = json.loads(match.group())

    action       = plan.get("action", "hold")
    reasoning    = plan.get("reasoning", "")
    market_brief = plan.get("marketBrief", "")
    confidence   = plan.get("confidence", 0.8)

    _auto_cfg["last_run"] = datetime.now()

    if action == "hold" or confidence < 0.7:
        msg = f"⏸️ *AURUM Auto: mantener posiciones*\n\n💬 _{reasoning}_\n📊 {market_brief}"
        logger.info(f"[Auto] Decisión: HOLD — {reasoning}")
        await telegram_notify(msg)
        _log_action({"type": "hold", "reasoning": reasoning, "market": market_brief, "trigger": trigger_reason})
        return {"action": "hold", "reasoning": reasoning, "executed": 0}

    trades = plan.get("trades", [])
    if not trades:
        return {"action": "hold", "reasoning": "Sin trades generados", "executed": 0}

    # El plan de Claude no es una fuente de confianza: validarlo antes de
    # enviarlo al broker y rechazar cualquier exceso de presupuesto.
    try:
        validated_trades = [TradeItem.model_validate(trade) for trade in trades]
    except Exception as e:
        raise ValueError(f"Plan autónomo inválido: {e}") from e
    if sum(trade.amount for trade in validated_trades) > budget:
        raise ValueError("Plan autónomo supera el presupuesto configurado")

    # Ejecutar órdenes en TR. El ciclo autónomo corre bajo la identidad del
    # propietario y está sujeto al mismo interruptor maestro que la API.
    _ensure_trading_enabled()
    _check_daily_limit(OWNER_EMAIL, sum(t.amount for t in validated_trades))

    results = []
    for t in validated_trades:
        try:
            logger.info(f"[Auto] Ejecutando {t.amount:.0f}€ de {t.ticker}…")
            order = await tr.buy_cash_amount(t.isin, t.amount)
            db.record_order(f"auto-{int(time.time()*1000)}-{t.isin}", f"auto-{int(time.time()*1000)}-{t.isin}",
                            OWNER_EMAIL, "buy", t.isin, t.amount, "executed",
                            ticker=t.ticker, broker_order_id=order.get("id", ""))
            results.append({"ticker": t.ticker, "amount": t.amount, "status": "ok", "id": order.get("id","")})
        except Exception as e:
            logger.error(f"[Auto] Error orden {t.ticker}: {e}")
            results.append({"ticker": t.ticker, "amount": t.amount, "status": "error", "error": str(e)})

    executed_list = [r for r in results if r["status"] == "ok"]
    total_exec    = sum(r["amount"] for r in executed_list)

    trades_txt = "\n".join(f"  ✅ *{r['ticker']}*: {r['amount']:.0f}€" for r in executed_list)
    failed_txt = "\n".join(f"  ❌ {r['ticker']}: {r.get('error','?')[:40]}" for r in results if r["status"] == "error")
    if failed_txt:
        trades_txt += "\n" + failed_txt

    interval_h = _auto_cfg.get("interval_hours", 168)
    logger.info(f"[Auto] Ciclo completado: {len(executed_list)}/{len(results)} ejecutadas, {total_exec:.0f}€")
    await telegram_notify(
        f"🤖 *AURUM ejecutó ciclo autónomo*\n\n"
        f"{trades_txt}\n\n"
        f"💰 Total invertido: *{total_exec:.0f}€*\n"
        f"📊 {market_brief}\n"
        f"💬 _{reasoning}_\n\n"
        f"🔁 Trigger: _{trigger_reason}_\n"
        f"_Próximo ciclo programado en ~{interval_h}h_"
    )

    _log_action({
        "type":     action,
        "trades":   [{"ticker": r["ticker"], "amount": r["amount"], "status": r["status"]} for r in results],
        "total":    total_exec,
        "reasoning": reasoning,
        "market":   market_brief,
        "trigger":  trigger_reason,
        "confidence": confidence,
    })
    return {"action": action, "trades": results, "total_exec": total_exec, "reasoning": reasoning}


async def _run_auto_cycle():
    """
    Loop principal del scheduler autónomo:
    - Revisa cada hora si hay triggers inteligentes o si toca ciclo programado
    - Delega la ejecución a _execute_auto_cycle()
    """
    while True:
        await asyncio.sleep(3600)  # revisar cada hora
        if not _auto_cfg["enabled"]:
            continue
        if not tr.authenticated:
            logger.info("[Auto] TR no autenticado — saltando")
            continue

        try:
            # 1. Comprobar triggers inteligentes
            trigger = await _check_smart_triggers()
            if trigger:
                logger.info(f"[Auto] Smart trigger activado: {trigger}")
                await _execute_auto_cycle(trigger)
                continue

            # 2. Comprobar ciclo programado
            interval_h = _auto_cfg.get("interval_hours", 168)
            last_run   = _auto_cfg.get("last_run")
            if last_run:
                elapsed_h = (datetime.now() - last_run).total_seconds() / 3600
                if elapsed_h < interval_h:
                    continue

            await _execute_auto_cycle("ciclo programado")

        except Exception as e:
            logger.error(f"[Auto] Error en ciclo: {e}")
            await telegram_notify(f"❌ *AURUM Auto error*: {str(e)[:200]}")


# ── App lifecycle ────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _schedule_task
    logger.info("AURUM Backend v2 arrancando…")

    db.connect()
    # La sesión de broker que se crea con las credenciales del .env pertenece al
    # propietario: se registra a su nombre para que la API y el ciclo autónomo
    # vean exactamente la misma sesión.
    broker_sessions.adopt(OWNER_EMAIL, tr)

    if not secrets_available():
        logger.warning(
            "AURUM_SECRET_KEY no configurada: las credenciales de broker por "
            "usuario están desactivadas hasta que se defina."
        )
    if not TRADING_ENABLED:
        logger.warning("AURUM_TRADING_ENABLED=false: ninguna orden llegará al broker.")
    if db.count_tokens() == 0:
        logger.warning(
            "No hay tokens emitidos. Crea el primero con POST /admin/tokens "
            "usando AURUM_API_KEY; después esa clave dejará de servir."
        )

    if TR_PHONE and TR_PIN:
        try:
            await tr.login_init(TR_PHONE, TR_PIN)
            logger.info("OTP enviado a tu teléfono TR. Usa POST /auth/verify para completar.")
        except Exception as e:
            logger.warning(f"Auto-login no pudo iniciar: {e}")

    _schedule_task = asyncio.create_task(_run_auto_cycle())
    logger.info("Scheduler autónomo iniciado.")

    # Telegram bot
    _tg_bot = None
    if TELEGRAM_TOKEN:
        try:
            from telegram_bot import start_bot
            _tg_bot = await start_bot(TELEGRAM_TOKEN, tr, _auto_cfg)
            logger.info("Telegram bot arrancado.")
        except Exception as e:
            logger.warning(f"Telegram bot no pudo arrancar: {e}")

    await telegram_notify("✅ *AURUM Backend* arrancado y listo.")

    yield

    _schedule_task.cancel()
    if _tg_bot:
        try:
            from telegram_bot import stop_bot
            await stop_bot()
        except Exception:
            pass
    from computer_agent import close_agent
    await close_agent()
    await broker_sessions.disconnect_all()
    await tr.disconnect()
    logger.info("AURUM Backend apagado.")
    await telegram_notify("🔴 *AURUM Backend* apagado.")


app = FastAPI(title="AURUM Backend", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
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
    ticker: str = Field(min_length=1, max_length=24)
    isin:   str = Field(min_length=1, max_length=32)
    amount: float = Field(gt=0, le=MAX_TRADE_AMOUNT_EUR)
    name:   str = Field(min_length=1, max_length=160)

class InvestRequest(BaseModel):
    trades: list[TradeItem]
    # Identifica la intención del cliente. Si se repite la misma petición (por
    # un reintento de red o un doble toque), la orden no se ejecuta dos veces.
    idempotency_key: str = Field(default="", max_length=80)
    # Token del primer paso de la doble confirmación (POST /orders/prepare).
    confirmation_token: str = Field(default="", max_length=120)

class AutoRunRequest(BaseModel):
    trades:   list[TradeItem]
    reasoning: str = ""
    notify:   bool = True   # enviar Telegram

class ScheduleConfig(BaseModel):
    enabled:        bool
    interval_hours: int   = Field(default=168, ge=24, le=24 * 31)
    max_amount:     float = Field(default=100.0, ge=10, le=MAX_TRADE_AMOUNT_EUR)
    # Perfil e intenciones del inversor (opcionales)
    profile:        str   = "moderado"   # conservador | moderado | agresivo
    target_alloc:   str   = ""           # asignación objetivo libre
    user_goals:     str   = ""           # objetivos del inversor

class SellItem(BaseModel):
    ticker: str = Field(min_length=1, max_length=24)
    isin:   str = Field(min_length=1, max_length=32)
    shares: float = Field(default=0.0, ge=0, le=1_000_000)
    amount: float = Field(default=0.0, ge=0, le=MAX_TRADE_AMOUNT_EUR)
    name:   str   = ""

class SellRequest(BaseModel):
    trades: list[SellItem]
    notify: bool = True
    idempotency_key: str = Field(default="", max_length=80)
    confirmation_token: str = Field(default="", max_length=120)


class BrokerCredentialsRequest(BaseModel):
    phone: str = Field(min_length=6, max_length=24)
    pin:   str = Field(min_length=4, max_length=12)


class BrokerOtpRequest(BaseModel):
    otp: str = Field(min_length=3, max_length=10)


class TokenRequest(BaseModel):
    user_email: str = Field(min_length=3, max_length=254)
    role:       str = Field(default="user")
    scopes:     list[str] = Field(default_factory=lambda: [SCOPE_READ])
    label:      str = Field(default="", max_length=80)
    ttl_days:   Optional[int] = Field(default=None, ge=1, le=3650)


class PrepareOrderRequest(BaseModel):
    """Primer paso de la doble confirmación: congela el plan y devuelve token."""
    side:   str = Field(pattern="^(buy|sell)$")
    trades: list[dict]


# ── Guardas de ejecución de órdenes ──────────────────────────────────────────

def _ensure_trading_enabled() -> None:
    """
    Interruptor maestro. Mientras AURUM_TRADING_ENABLED sea false, ninguna orden
    sale hacia el broker, se pida desde donde se pida.
    """
    if not TRADING_ENABLED:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "La ejecución de órdenes está desactivada en este backend "
            "(AURUM_TRADING_ENABLED=false).",
        )


def _check_daily_limit(user_email: str, amount_eur: float) -> None:
    """Tope acumulado en 24 h, además del tope por orden."""
    already = db.executed_today_eur(user_email)
    if already + amount_eur > MAX_DAILY_EUR:
        raise HTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            f"Superarías el límite diario ({MAX_DAILY_EUR:.0f}€). "
            f"Ejecutado en las últimas 24 h: {already:.2f}€.",
        )


def _require_confirmation(principal: Principal, token: str, expected: dict) -> None:
    """
    Segundo paso de la doble confirmación. El plan que se ejecuta tiene que ser
    exactamente el que se preparó: si cambia el valor o el importe, se rechaza.
    """
    if not token:
        raise HTTPException(
            status.HTTP_428_PRECONDITION_REQUIRED,
            "Falta el token de confirmación. Prepara la operación en POST /orders/prepare.",
        )
    plan = db.consume_confirmation(principal.user_email, token)
    if plan is None:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Token de confirmación inválido, caducado o ya usado.")
    if plan != expected:
        db.audit("order_confirmation_mismatch", principal.user_email, {"expected": expected, "plan": plan})
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "La operación no coincide con la que se confirmó.",
        )


def _order_plan(side: str, trades: list) -> dict:
    """Representación canónica del plan, para comparar preparación y ejecución."""
    items = []
    for t in trades:
        data = t if isinstance(t, dict) else t.model_dump()
        items.append({
            "isin": data.get("isin", ""),
            "amount": round(float(data.get("amount", 0) or 0), 2),
            "shares": round(float(data.get("shares", 0) or 0), 6),
        })
    items.sort(key=lambda x: (x["isin"], x["amount"], x["shares"]))
    return {"side": side, "items": items}


def _idempotency_key(provided: str, plan: dict) -> str:
    """Si el cliente no manda clave, se deriva del propio plan."""
    if provided.strip():
        return provided.strip()[:80]
    return hashlib.sha256(json.dumps(plan, sort_keys=True).encode("utf-8")).hexdigest()[:32]


# Rutas de identidad, credenciales de broker y doble confirmación.
# Se registran desde un módulo aparte para no seguir engordando este fichero.
endpoints_identity.register(
    app,
    require_key=require_key,
    require_scope=require_scope,
    bootstrap_key_valid=_bootstrap_key_valid,
    order_plan=_order_plan,
    owner_email=OWNER_EMAIL,
    trading_enabled=TRADING_ENABLED,
    max_daily_eur=MAX_DAILY_EUR,
)


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
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_READ)
    try:
        process_id = await tr.login_init(body.phone, body.pin)
        return {"status": "otp_sent", "processId": process_id}
    except TRAuthError as e:
        raise HTTPException(400, str(e))


@app.post("/auth/verify")
async def auth_verify(body: AuthVerifyRequest, x_aurum_key: str = Header(default="")):
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_READ)
    try:
        await tr.login_verify(body.otp)
        await tr.connect()
        await telegram_notify("✅ *Trade Republic autenticado*. AURUM puede ejecutar órdenes.")
        return {"status": "authenticated"}
    except TRAuthError as e:
        raise HTTPException(400, str(e))


@app.get("/portfolio")
async def get_portfolio(x_aurum_key: str = Header(default="")):
    """Cartera del broker del usuario que pregunta, no de una cuenta común."""
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_READ)
    try:
        session = await broker_sessions.require_authenticated(principal.user_email)
        positions = await session.client.get_portfolio()
        cash      = await session.client.get_cash()
        return {"positions": positions, "cash": cash}
    except TRAuthError as e:
        raise HTTPException(401, str(e))
    except Exception as e:
        raise HTTPException(500, str(e))


@app.post("/invest")
async def invest(body: InvestRequest, x_aurum_key: str = Header(default="")):
    """
    Ejecuta órdenes de compra en el broker del usuario.

    Cuatro controles antes de tocar el broker: interruptor maestro, doble
    confirmación, idempotencia y límite diario acumulado.
    """
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_EXECUTE)
    _ensure_trading_enabled()
    if not body.trades:
        raise HTTPException(400, "Lista de trades vacía")

    plan = _order_plan("buy", body.trades)
    _require_confirmation(principal, body.confirmation_token, plan)

    key = _idempotency_key(body.idempotency_key, plan)
    previous = db.find_order(principal.user_email, key)
    if previous:
        # Reintento de una orden ya procesada: se devuelve el resultado guardado
        # en lugar de comprar dos veces.
        db.audit("order_idempotent_replay", principal.user_email, {"key": key})
        return {"results": [previous], "total_executed": 1 if previous["status"] == "executed" else 0,
                "total_trades": 1, "replayed": True}

    total = sum(t.amount for t in body.trades)
    _check_daily_limit(principal.user_email, total)

    try:
        session = await broker_sessions.require_authenticated(principal.user_email)
    except TRAuthError as e:
        # Sin sesión de broker no hay nada que ejecutar. La confirmación ya se
        # consumió, así que habrá que volver a prepararla tras iniciar sesión.
        raise HTTPException(401, str(e))

    results = []
    for idx, trade in enumerate(body.trades):
        order_id = f"{key}-{idx}"
        try:
            logger.info("Ejecutando compra de %.2f€ en %s para %s", trade.amount, trade.ticker, principal.user_email)
            order_data = await session.client.buy_cash_amount(trade.isin, trade.amount)
            results.append({
                "ticker": trade.ticker, "isin": trade.isin, "amount": trade.amount,
                "status": "executed",   "orderId": order_data.get("id", ""),
            })
            db.record_order(order_id, key, principal.user_email, "buy", trade.isin, trade.amount,
                            "executed", ticker=trade.ticker, broker_order_id=order_data.get("id", ""))
        except Exception as e:
            logger.error(f"Error orden {trade.ticker}: {e}")
            results.append({"ticker": trade.ticker, "isin": trade.isin, "amount": trade.amount, "status": "error", "error": str(e)})
            db.record_order(order_id, f"{key}-err-{idx}", principal.user_email, "buy", trade.isin, trade.amount,
                            "error", ticker=trade.ticker, error=str(e)[:500])

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
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_EXECUTE)
    if not tr.authenticated:
        raise HTTPException(401, "No autenticado en Trade Republic")
    if not _auto_cfg["enabled"]:
        raise HTTPException(403, "Modo autónomo no activado. Actívalo en Ajustes.")
    if not body.trades:
        return {"results": [], "message": "AURUM decidió no invertir en este ciclo."}
    if sum(trade.amount for trade in body.trades) > _auto_cfg["max_amount"]:
        raise HTTPException(400, "El total de órdenes supera el presupuesto autónomo configurado")

    _ensure_trading_enabled()
    _check_daily_limit(principal.user_email, sum(trade.amount for trade in body.trades))

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


@app.post("/sell")
async def sell(body: SellRequest, x_aurum_key: str = Header(default="")):
    """
    Vende posiciones en Trade Republic.
    Especifica shares (unidades) o amount (€). Si ambos, se usa shares.
    """
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_EXECUTE)
    _ensure_trading_enabled()
    if not body.trades:
        raise HTTPException(400, "Lista de trades vacía")

    plan = _order_plan("sell", body.trades)
    _require_confirmation(principal, body.confirmation_token, plan)

    key = _idempotency_key(body.idempotency_key, plan)
    previous = db.find_order(principal.user_email, key)
    if previous:
        db.audit("order_idempotent_replay", principal.user_email, {"key": key})
        return {"results": [previous], "total_executed": 1 if previous["status"] == "executed" else 0, "replayed": True}

    try:
        session = await broker_sessions.require_authenticated(principal.user_email)
    except TRAuthError as e:
        # Sin sesión de broker no hay nada que ejecutar. La confirmación ya se
        # consumió, así que habrá que volver a prepararla tras iniciar sesión.
        raise HTTPException(401, str(e))

    results = []
    for idx, trade in enumerate(body.trades):
        order_id = f"{key}-{idx}"
        try:
            if trade.shares > 0:
                order_data = await session.client.sell_shares(trade.isin, trade.shares)
                desc = f"{trade.shares} acciones"
            elif trade.amount > 0:
                order_data = await session.client.sell_cash_amount(trade.isin, trade.amount)
                desc = f"{trade.amount:.0f}€"
            else:
                raise ValueError("Especifica 'shares' o 'amount'")

            logger.info("Venta %s (%s) para %s", trade.ticker, desc, principal.user_email)
            results.append({
                "ticker":  trade.ticker, "isin": trade.isin,
                "status":  "executed",   "orderId": order_data.get("id", ""),
                "desc":    desc,
            })
            db.record_order(order_id, key, principal.user_email, "sell", trade.isin, trade.amount,
                            "executed", ticker=trade.ticker, shares=trade.shares,
                            broker_order_id=order_data.get("id", ""))
        except Exception as e:
            logger.error(f"Error venta {trade.ticker}: {e}")
            results.append({"ticker": trade.ticker, "isin": trade.isin, "status": "error", "error": str(e)})
            db.record_order(order_id, f"{key}-err-{idx}", principal.user_email, "sell", trade.isin, trade.amount,
                            "error", ticker=trade.ticker, shares=trade.shares, error=str(e)[:500])

    executed = sum(1 for r in results if r["status"] == "executed")
    if executed and body.notify:
        lines = "\n".join(f"  • {r['ticker']}: {r.get('desc','?')}" for r in results if r["status"] == "executed")
        await telegram_notify(f"📤 *AURUM vendió {executed} posición(es)*\n{lines}")

    return {"results": results, "total_executed": executed}


@app.post("/schedule")
async def configure_schedule(body: ScheduleConfig, x_aurum_key: str = Header(default="")):
    """Configura el modo autónomo del backend (desde el frontend)."""
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_ADMIN)
    _auto_cfg.update({
        "enabled":        body.enabled,
        "interval_hours": body.interval_hours,
        "max_amount":     body.max_amount,
        "profile":        body.profile,
        "target_alloc":   body.target_alloc,
        "user_goals":     body.user_goals,
    })
    status_str = "activado" if body.enabled else "desactivado"
    pm = _PROFILE_META.get(body.profile, _PROFILE_META["moderado"])
    logger.info(f"Schedule {status_str}: perfil={body.profile}, intervalo={body.interval_hours}h, máx={body.max_amount}€")
    if body.enabled:
        await telegram_notify(
            f"⚙️ *AURUM modo autónomo {status_str}*\n"
            f"Perfil: {pm['label']}\n"
            f"Intervalo: cada {body.interval_hours}h\n"
            f"Presupuesto máximo: {body.max_amount:.0f}€/ciclo\n"
            f"Asignación objetivo: {body.target_alloc or pm['alloc']}"
        )
    return {"status": "ok", "auto_enabled": _auto_cfg["enabled"], "profile": body.profile}


@app.post("/run-now")
async def run_now(body: dict = {}, x_aurum_key: str = Header(default="")):
    """
    Dispara inmediatamente un ciclo autónomo completo, sin esperar al intervalo.
    Útil para: oportunidades puntuales, primer setup, test.
    """
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_EXECUTE)
    if not tr.authenticated:
        raise HTTPException(401, "No autenticado en Trade Republic")

    reason = body.get("reason", "disparo manual desde la app")
    logger.info(f"[RunNow] Ciclo forzado: {reason}")

    # Activar temporalmente si no está activado (solo para este ciclo)
    was_enabled = _auto_cfg.get("enabled", False)
    _auto_cfg["enabled"] = True

    try:
        result = await _execute_auto_cycle(reason)
    except Exception as e:
        _auto_cfg["enabled"] = was_enabled
        raise HTTPException(500, str(e))

    _auto_cfg["enabled"] = was_enabled
    return result


@app.get("/auto-log")
async def get_auto_log(x_aurum_key: str = Header(default=""), limit: int = 20):
    """Devuelve el log de ejecuciones autónomas (para mostrar en el frontend)."""
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_READ)
    log = list(reversed(_auto_cfg.get("action_log", [])))[:limit]
    return {
        "log":         log,
        "auto_enabled": _auto_cfg.get("enabled", False),
        "profile":     _auto_cfg.get("profile", "moderado"),
        "max_amount":  _auto_cfg.get("max_amount", 100),
        "interval_h":  _auto_cfg.get("interval_hours", 168),
        "last_run":    _auto_cfg["last_run"].isoformat() if _auto_cfg.get("last_run") else None,
        "next_run":    (
            (_auto_cfg["last_run"] + timedelta(hours=_auto_cfg.get("interval_hours",168))).isoformat()
            if _auto_cfg.get("last_run") else None
        ),
    }


@app.post("/notify")
async def manual_notify(body: dict, x_aurum_key: str = Header(default="")):
    """Envía un mensaje personalizado al Telegram del usuario."""
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_ADMIN)
    msg = body.get("message", "")
    if msg:
        await telegram_notify(msg)
    return {"status": "sent"}


# ── /prices — precios en tiempo real via Yahoo Finance (sin tokens) ──────────

# Mapa de tickers AURUM → Yahoo Finance (Xetra .DE o London .L)
_YAHOO_MAP: dict[str, str] = {
    # ETFs (Xetra .DE / London .L)
    "VWCE":  "VWCE.DE",  "XEON":  "XEON.DE",  "SPPW":  "SPPW.DE",
    "SGLN":  "SGLN.DE",  "EUNL":  "EUNL.DE",  "VUSA":  "VUSA.L",
    "IEMA":  "IEMA.DE",  "ZPRV":  "ZPRV.DE",  "IUSE":  "IUSE.DE",
    "VHYL":  "VHYL.L",   "AGGU":  "AGGU.L",   "IS3N":  "IS3N.DE",
    "QDVE":  "QDVE.DE",  "XDWD":  "XDWD.DE",  "EXXT":  "EXXT.DE",
    "BTCE":  "BTCE.DE",  "WGLD":  "WGLD.DE",  "IWDA":  "IWDA.AS",
    # Índices y mercado (pass-through — Yahoo los acepta tal cual)
    "IBEX35":  "^IBEX",    "SP500":   "^GSPC",
    "NASDAQ":  "^IXIC",    "DAX":     "^GDAXI",
    "EURUSD":  "EURUSD=X", "EURUSD=X": "EURUSD=X",
    "BTCEUR":  "BTC-EUR",  "BTC-EUR": "BTC-EUR",
    "GOLD":    "GC=F",     "GC=F":    "GC=F",
    "^IBEX":   "^IBEX",    "^GSPC":   "^GSPC",
    "^IXIC":   "^IXIC",    "^GDAXI":  "^GDAXI",
}

async def _yahoo_prices(tickers: list[str]) -> dict[str, float]:
    """Obtiene precios de Yahoo Finance. Devuelve {ticker: price}."""
    yahoo_syms = [_YAHOO_MAP.get(t, t) for t in tickers]
    sym_str    = ",".join(yahoo_syms)
    url = f"https://query1.finance.yahoo.com/v7/finance/quote?symbols={sym_str}&fields=regularMarketPrice"
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json",
    }
    result = {}
    async with httpx.AsyncClient(timeout=8, headers=headers) as client:
        r = await client.get(url)
        r.raise_for_status()
        data = r.json()
    quotes = data.get("quoteResponse", {}).get("result", [])
    for q in quotes:
        sym   = q.get("symbol", "")
        price = q.get("regularMarketPrice") or q.get("ask") or 0.0
        # Revertir el mapeo para devolver el ticker AURUM original
        orig = next((k for k, v in _YAHOO_MAP.items() if v == sym), sym)
        if price:
            result[orig] = round(price, 4)
    return result


@app.get("/prices")
async def get_prices_endpoint(tickers: str, x_aurum_key: str = Header(default="")):
    """
    Precios en tiempo real para los tickers indicados.
    Usa Yahoo Finance (gratis, sin tokens de IA).
    ?tickers=VWCE,XEON,SPPW
    """
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_READ)
    ticker_list = [t.strip().upper() for t in tickers.split(",") if t.strip()]
    if not ticker_list:
        raise HTTPException(400, "Parámetro 'tickers' vacío")

    try:
        prices = await _yahoo_prices(ticker_list)
        return {
            "prices": [{"ticker": t, "price": prices.get(t, 0)} for t in ticker_list],
            "source": "yahoo_finance",
            "ts":     datetime.now().isoformat(),
        }
    except Exception as e:
        logger.warning(f"[Prices] Yahoo Finance error: {e} — usando Claude fallback")
        # Fallback a Claude si Yahoo falla
        try:
            raw = await _call_claude(
                "Eres un asistente financiero. Devuelve SOLO JSON: [{\"ticker\":\"X\",\"price\":0.0}]",
                f"Precios actuales de: {', '.join(ticker_list)}. SOLO JSON válido.",
                max_tokens=400, web_search=True,
            )
            m = re.search(r"\[[\s\S]*\]", raw)
            if m:
                return {"prices": json.loads(m.group()), "source": "claude_fallback", "ts": datetime.now().isoformat()}
        except Exception as e2:
            logger.error(f"[Prices] Claude fallback error: {e2}")
        raise HTTPException(503, f"No se pudieron obtener precios: {e}")


# ── /market — índices de mercado en tiempo real (sin auth) ──────────────────

_MARKET_SYMBOLS = [
    {"key": "IBEX35",  "symbol": "^IBEX",    "name": "IBEX 35",  "currency": "EUR"},
    {"key": "SP500",   "symbol": "^GSPC",    "name": "S&P 500",  "currency": "USD"},
    {"key": "NASDAQ",  "symbol": "^IXIC",    "name": "Nasdaq",   "currency": "USD"},
    {"key": "EURUSD",  "symbol": "EURUSD=X", "name": "EUR/USD",  "currency": "FX" },
    {"key": "BTCEUR",  "symbol": "BTC-EUR",  "name": "Bitcoin",  "currency": "EUR"},
    {"key": "GOLD",    "symbol": "GC=F",     "name": "Oro",      "currency": "USD"},
]

@app.get("/market")
async def get_market():
    """
    Snapshot de índices en tiempo real (sin autenticación).
    Usado por el frontend y el Telegram bot.
    """
    symbols_str = ",".join(s["symbol"] for s in _MARKET_SYMBOLS)
    url = (
        f"https://query1.finance.yahoo.com/v7/finance/quote"
        f"?symbols={symbols_str}"
        f"&fields=regularMarketPrice,regularMarketChangePercent"
    )
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}
    try:
        async with httpx.AsyncClient(timeout=8, headers=headers) as c:
            r = await c.get(url)
            r.raise_for_status()
            quotes = r.json().get("quoteResponse", {}).get("result", [])

        result = []
        for m in _MARKET_SYMBOLS:
            q = next((x for x in quotes if x.get("symbol") == m["symbol"]), None)
            result.append({
                "key":       m["key"],
                "name":      m["name"],
                "currency":  m["currency"],
                "price":     q.get("regularMarketPrice") if q else None,
                "changePct": q.get("regularMarketChangePercent") if q else None,
            })

        return {"data": result, "ts": int(datetime.now().timestamp() * 1000)}

    except Exception as e:
        logger.warning(f"[Market] Yahoo error: {e}")
        raise HTTPException(502, f"No se pudieron obtener datos de mercado: {e}")


# ── /do — intérprete de órdenes en lenguaje natural ─────────────────────────

class DoRequest(BaseModel):
    command: str           # orden en lenguaje natural
    capital: float = 0.0   # opcional: presupuesto si el usuario lo especifica
    context: dict  = {}    # contexto adicional (portfolio, profile, etc.)

_DO_SYSTEM = """\
Eres AURUM, gestor financiero autónomo. El usuario te da una orden en lenguaje natural.
Usa búsqueda web si necesitas datos actuales del mercado.

Interpreta la orden y devuelve SOLO JSON:
{
  "action": "invest|portfolio|auto_on|auto_off|status|advise|notify",
  "amount": 0,
  "message": "respuesta al usuario en español",
  "trades": [{"ticker":"VWCE","isin":"IE00B3RBWM25","name":"Vanguard FTSE All-World","amount":300}]
}

Reglas:
- "invest": genera trades para invertir amount€. trades[] con suma = amount.
- "portfolio": devuelve solo action + message.
- "auto_on"/"auto_off": toggle del modo autónomo.
- "status": información del sistema.
- "advise": responde como asesor (message contiene la respuesta completa).
- "notify": message contiene el texto a enviar por Telegram.
- Solo instrumentos disponibles en Trade Republic España.
- ETFs preferidos: VWCE, XEON, SPPW, SGLN, EUNL, VUSA, IEMA.
"""


@app.post("/do")
async def do_command(body: DoRequest, x_aurum_key: str = Header(default="")):
    """
    Ejecuta cualquier orden en lenguaje natural.
    AURUM interpreta, decide y actúa.
    """
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_ADMIN)

    context_str = ""
    if body.context:
        context_str = f"\nContexto adicional: {json.dumps(body.context, ensure_ascii=False)}"

    user_msg = f"Orden: {body.command}{context_str}"
    if body.capital > 0:
        user_msg += f"\nPresupuesto disponible: {body.capital:.2f}€"

    try:
        raw = await _call_claude(_DO_SYSTEM, user_msg, max_tokens=1024, web_search=True)
    except Exception as e:
        raise HTTPException(500, f"Claude error: {e}")

    match = re.search(r"\{[\s\S]*\}", raw)
    if not match:
        return {"action": "advise", "message": raw, "executed": False}

    try:
        plan = json.loads(match.group())
    except json.JSONDecodeError:
        return {"action": "advise", "message": raw, "executed": False}

    action  = plan.get("action", "advise")
    message = plan.get("message", "")
    trades  = plan.get("trades", [])
    result  = {"action": action, "message": message, "executed": False}

    # Ejecutar la acción detectada
    if action == "invest" and trades:
        if not TRADING_ENABLED:
            result["message"] = "⚠️ La ejecución de órdenes está desactivada en este backend."
        elif not tr.authenticated:
            result["message"] = "⚠️ No autenticado en Trade Republic."
        else:
            await tr.ensure_connected()
            exec_results = []
            for t in trades:
                try:
                    order = await tr.buy_cash_amount(t["isin"], t["amount"])
                    exec_results.append({"ticker": t["ticker"], "amount": t["amount"], "status": "executed", "orderId": order.get("id","")})
                except Exception as e:
                    exec_results.append({"ticker": t["ticker"], "amount": t["amount"], "status": "error", "error": str(e)})
            executed = sum(1 for r in exec_results if r["status"] == "executed")
            total    = sum(r["amount"] for r in exec_results if r["status"] == "executed")
            result["executed"]     = executed > 0
            result["trades"]       = exec_results
            result["total_executed"] = total
            if executed:
                trades_txt = "\n".join(f"  • {r['ticker']}: {r['amount']:.0f}€" for r in exec_results if r["status"] == "executed")
                await telegram_notify(f"🤖 *AURUM /do ejecutó {executed} orden(es)*\n{trades_txt}\nTotal: *{total:.0f}€*\n\n_{message}_")

    elif action == "portfolio":
        if tr.authenticated:
            try:
                await tr.ensure_connected()
                positions = await tr.get_portfolio()
                cash      = await tr.get_cash()
                result["portfolio"] = positions
                result["cash"]      = cash
                result["executed"]  = True
            except Exception as e:
                result["message"] = f"Error obteniendo cartera: {e}"

    elif action == "auto_on":
        _auto_cfg["enabled"] = True
        amount = float(plan.get("amount", 0))
        if amount > 0:
            _auto_cfg["max_amount"] = amount
        result["executed"] = True
        await telegram_notify(f"🟢 *AURUM auto activado* vía /do — máx {_auto_cfg['max_amount']:.0f}€/ciclo")

    elif action == "auto_off":
        _auto_cfg["enabled"] = False
        result["executed"] = True
        await telegram_notify("🔴 *AURUM auto desactivado* vía /do")

    elif action == "notify":
        await telegram_notify(message)
        result["executed"] = True

    elif action == "status":
        result["status"] = {
            "tr_authenticated": tr.authenticated,
            "auto_enabled":     _auto_cfg.get("enabled", False),
            "max_amount":       _auto_cfg.get("max_amount", 100),
            "interval_hours":   _auto_cfg.get("interval_hours", 168),
            "last_run":         _auto_cfg["last_run"].isoformat() if _auto_cfg.get("last_run") else None,
        }
        result["executed"] = True

    return result


# ── /computer — control autónomo de navegador vía Playwright + Claude vision ─

class ComputerRequest(BaseModel):
    task:        str = Field(min_length=1, max_length=2_000)
    url:         str = Field(default="", max_length=2_000)
    credentials: dict = Field(default_factory=dict)
    headless:    bool  = True
    max_steps:   int   = Field(default=25, ge=1, le=25)

@app.post("/computer")
async def computer_task(body: ComputerRequest, x_aurum_key: str = Header(default="")):
    """
    Ejecuta una tarea en un navegador controlado por AURUM + Claude Vision.
    No necesita intervención del usuario.
    Ejemplos: "extrae mi saldo de Revolut", "compra VWCE en Degiro", etc.
    """
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_ADMIN)
    from computer_agent import get_agent
    agent = get_agent(headless=body.headless)
    try:
        result = await agent.run_task(
            task=body.task,
            start_url=body.url or None,
            max_steps=body.max_steps,
            credentials=body.credentials or None,
        )
        if result["success"]:
            await telegram_notify(f"🖥️ *AURUM Computer*: tarea completada\n_{body.task}_\n\nResultado: {result['result'][:500]}")
        return result
    except Exception as e:
        logger.error(f"[Computer] Error: {e}")
        raise HTTPException(500, str(e))


# ── Local agent command queue ────────────────────────────────────────────────
# El agente local (local_agent.py corriendo en el PC del usuario) hace polling
# de comandos pendientes y reporta resultados.

import uuid as _uuid

_agent_queue:   list[dict] = []   # comandos pendientes para el agente local
_agent_results: dict       = {}   # resultados por id
_agent_info:    dict       = {}   # info del agente registrado


class AgentCommandRequest(BaseModel):
    command: dict          # {type: "screenshot"|"click"|"type"|..., ...}
    wait_result: bool = True
    timeout_sec: int  = Field(default=30, ge=1, le=60)

class AgentResultRequest(BaseModel):
    id:     str
    result: dict


@app.post("/agent/register")
async def agent_register(body: dict, x_aurum_key: str = Header(default="")):
    """El agente local se registra con sus capacidades."""
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_ADMIN)
    global _agent_info
    _agent_info = {**body, "registered_at": datetime.now().isoformat(), "online": True}
    logger.info(f"[Agent] Local agent registrado: {body}")
    await telegram_notify(f"🖥️ *AURUM Local Agent conectado*\nOS: {body.get('os','?')} | pyautogui: {body.get('pyautogui','?')}")
    return {"status": "registered"}


@app.get("/agent/status")
async def agent_status(x_aurum_key: str = Header(default="")):
    """Estado del agente local."""
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_ADMIN)
    return {
        "connected": bool(_agent_info),
        "info":      _agent_info,
        "pending":   len(_agent_queue),
    }


@app.get("/agent/poll")
async def agent_poll(x_aurum_key: str = Header(default="")):
    """El agente local llama a este endpoint para recibir comandos pendientes."""
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_ADMIN)
    if not _agent_queue:
        return {"pending": False}
    cmd = _agent_queue.pop(0)
    return {"pending": True, "id": cmd["id"], "command": cmd["command"]}


@app.post("/agent/result")
async def agent_result(body: AgentResultRequest, x_aurum_key: str = Header(default="")):
    """El agente local reporta el resultado de un comando ejecutado."""
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_ADMIN)
    _agent_results[body.id] = body.result
    logger.info(f"[Agent] Resultado #{body.id}: {str(body.result)[:150]}")
    return {"status": "ok"}


@app.post("/agent/command")
async def agent_command(body: AgentCommandRequest, x_aurum_key: str = Header(default="")):
    """
    Envía un comando al agente local para ejecutar en el PC/móvil del usuario.
    Si wait_result=True, espera hasta timeout_sec segundos por el resultado.
    """
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_ADMIN)
    if not _agent_info:
        raise HTTPException(503, "Agente local no conectado. Ejecuta local_agent.py en tu PC.")
    allowed_commands = {"screenshot", "open_app", "click", "move", "type", "hotkey", "open_url", "scroll"}
    if body.command.get("type") not in allowed_commands:
        raise HTTPException(400, "Tipo de comando no permitido")

    cmd_id = str(_uuid.uuid4())[:8]
    _agent_queue.append({"id": cmd_id, "command": body.command})

    if not body.wait_result:
        return {"id": cmd_id, "queued": True}

    # Espera el resultado polling
    deadline = asyncio.get_event_loop().time() + body.timeout_sec
    while asyncio.get_event_loop().time() < deadline:
        if cmd_id in _agent_results:
            result = _agent_results.pop(cmd_id)
            return {"id": cmd_id, "result": result}
        await asyncio.sleep(0.5)

    # Timeout — devuelve pending
    return {"id": cmd_id, "result": None, "timeout": True}


@app.post("/agent/do")
async def agent_do_nl(body: dict, x_aurum_key: str = Header(default="")):
    """
    Ejecuta una orden en lenguaje natural en el PC del usuario
    usando un loop Claude-visión con el agente local.
    Claude ve screenshots y decide qué comandos enviar al agente.
    """
    principal = require_key(x_aurum_key)
    require_scope(principal, SCOPE_ADMIN)
    if not _agent_info:
        raise HTTPException(503, "Agente local no conectado. Ejecuta local_agent.py en tu PC.")

    task = body.get("task", "")
    if not task:
        raise HTTPException(400, "Campo 'task' requerido")

    if not ANTHROPIC_KEY:
        raise HTTPException(503, "ANTHROPIC_API_KEY no configurada")

    _AGENT_VISION_SYSTEM = """\
Eres AURUM, agente autónomo que controla el PC del usuario.
Tienes una screenshot del escritorio. Debes completar la tarea indicada.
Responde SOLO con JSON indicando la próxima acción:

{"action":"screenshot","reason":"necesito ver el estado actual"}
{"action":"open_url","url":"https://...","reason":"..."}
{"action":"open_app","app":"chrome","reason":"..."}
{"action":"click","x":100,"y":200,"reason":"..."}
{"action":"type","text":"texto a escribir","reason":"..."}
{"action":"hotkey","keys":["ctrl","c"],"reason":"..."}
{"action":"shell","command":"tasklist","reason":"..."}
{"action":"done","result":"resultado extraído","success":true}
"""

    history: list = []
    last_result: dict = {}

    # Primera screenshot
    ss_cmd_id = str(_uuid.uuid4())[:8]
    _agent_queue.append({"id": ss_cmd_id, "command": {"type": "screenshot"}})
    screenshot_b64 = ""

    for step in range(20):
        # Espera screenshot o usamos la última disponible
        if not screenshot_b64:
            deadline = asyncio.get_event_loop().time() + 8
            while asyncio.get_event_loop().time() < deadline:
                if ss_cmd_id in _agent_results:
                    screenshot_b64 = _agent_results.pop(ss_cmd_id).get("screenshot_b64", "")
                    break
                await asyncio.sleep(0.4)

        if not screenshot_b64:
            last_result = {"success": False, "result": "No se recibió screenshot del agente local"}
            break

        # Claude decide acción
        messages = list(history) + [{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": screenshot_b64}},
                {"type": "text", "text": f"Tarea: {task}\nPaso {step+1}. ¿Siguiente acción?"},
            ],
        }]

        try:
            async with httpx.AsyncClient(timeout=30) as hc:
                r = await hc.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={"x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json"},
                    json={"model": "claude-sonnet-5", "max_tokens": 256, "system": _AGENT_VISION_SYSTEM, "messages": messages},
                )
                r.raise_for_status()
                data = r.json()
        except Exception as e:
            last_result = {"success": False, "result": f"Claude error: {e}"}
            break

        text = " ".join(b["text"] for b in data.get("content", []) if b.get("type") == "text")
        m = re.search(r"\{[\s\S]*?\}", text)
        if not m:
            last_result = {"success": False, "result": "Sin JSON de Claude"}
            break
        try:
            action_data = json.loads(m.group())
        except Exception:
            last_result = {"success": False, "result": "JSON inválido"}
            break

        history.append({"role": "user", "content": f"Tarea: {task} Paso {step+1}. ¿Siguiente acción?"})
        history.append({"role": "assistant", "content": text})
        if len(history) > 12:
            history = history[-12:]

        action = action_data.get("action", "done")
        if action == "done":
            last_result = {"success": action_data.get("success", True), "result": action_data.get("result", "")}
            break

        # Envía comando al agente local
        cmd_map = {
            "open_url":  {"type": "open_url",  "url":     action_data.get("url", "")},
            "open_app":  {"type": "open_app",  "app":     action_data.get("app", "")},
            "click":     {"type": "click",     "x":       action_data.get("x", 0), "y": action_data.get("y", 0)},
            "type":      {"type": "type",      "text":    action_data.get("text", "")},
            "hotkey":    {"type": "hotkey",    "keys":    action_data.get("keys", [])},
            "shell":     {"type": "shell",     "command": action_data.get("command", "")},
            "screenshot":{"type": "screenshot"},
        }
        local_cmd = cmd_map.get(action)
        if not local_cmd:
            continue

        cmd_id = str(_uuid.uuid4())[:8]
        _agent_queue.append({"id": cmd_id, "command": local_cmd})

        # Espera resultado y toma nueva screenshot si necesario
        deadline = asyncio.get_event_loop().time() + 8
        exec_result = None
        while asyncio.get_event_loop().time() < deadline:
            if cmd_id in _agent_results:
                exec_result = _agent_results.pop(cmd_id)
                break
            await asyncio.sleep(0.4)

        # Solicita nueva screenshot para el próximo paso
        screenshot_b64 = exec_result.get("screenshot_b64", "") if exec_result else ""
        if not screenshot_b64:
            ss_cmd_id = str(_uuid.uuid4())[:8]
            _agent_queue.append({"id": ss_cmd_id, "command": {"type": "screenshot"}})
            screenshot_b64 = ""  # se llenará al inicio del próximo loop

    if last_result.get("success"):
        await telegram_notify(f"🖥️ *AURUM controlando tu PC*\n_{task}_\n\nResultado: {last_result.get('result','')[:400]}")

    return last_result


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=False)
