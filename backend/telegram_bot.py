"""
AURUM Telegram Bot — Control de dinero desde el móvil.

Comandos disponibles:
  /start      — Presenta AURUM y lista comandos
  /portfolio  — Cartera actual + saldo
  /cash       — Solo saldo disponible
  /invest <N> — AURUM decide cómo invertir N€ y ejecuta
  /auto on|off — Activa/desactiva modo autónomo
  /auto status — Estado del ciclo autónomo
  /status     — Estado del backend (TR auth, auto, última ejecución)
  /do <texto> — Orden en lenguaje natural (Claude interpreta y ejecuta)
  Texto libre — Claude responde como asesor financiero

Arranque: llamar a `start_bot()` desde el lifespan de FastAPI.
"""

import asyncio
import json
import logging
import os
from typing import Optional

import httpx
from telegram import Update, BotCommand
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    ContextTypes,
    filters,
)
from telegram.constants import ParseMode

logger = logging.getLogger(__name__)

# ── Globals inyectados por main.py ──────────────────────────────────────────
_tr_client = None       # TRClient instance
_auto_cfg:  dict = {}   # shared reference to main._auto_cfg
_bot_app:   Optional[Application] = None

ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "")
ALLOWED_CHAT   = os.getenv("TELEGRAM_CHAT_ID", "")   # solo acepta este chat


# ── Helpers ──────────────────────────────────────────────────────────────────

def _allowed(update: Update) -> bool:
    """Rechaza mensajes de chats no autorizados."""
    return not ALLOWED_CHAT or str(update.effective_chat.id) == ALLOWED_CHAT


async def _claude(system: str, user: str, max_tokens: int = 800) -> str:
    """
    Llama a Claude claude-sonnet-5 con búsqueda web.
    Maneja el loop tool_use → tool_result hasta end_turn (máx. 8 iteraciones).
    """
    if not ANTHROPIC_KEY:
        return "⚠️ ANTHROPIC_API_KEY no configurada."

    headers = {
        "x-api-key":         ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type":      "application/json",
    }
    body: dict = {
        "model":      "claude-sonnet-5",
        "max_tokens": max_tokens,
        "system":     system,
        "tools": [{"type": "web_search_20260209", "name": "web_search", "max_uses": 3}],
        "messages": [{"role": "user", "content": user}],
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
                ).strip() or "Sin respuesta."

            if stop == "tool_use":
                # Acknowledge tool use y continúa el loop
                body["messages"].append({"role": "assistant", "content": data["content"]})
                body["messages"].append({
                    "role": "user",
                    "content": [
                        {"type": "tool_result", "tool_use_id": b["id"], "content": "search executed"}
                        for b in data["content"] if b.get("type") == "tool_use"
                    ],
                })
            else:
                # Parada inesperada — extrae texto si hay
                return " ".join(
                    b["text"] for b in data.get("content", []) if b.get("type") == "text"
                ).strip() or "Sin respuesta."

    return "Sin respuesta (límite de iteraciones)."


async def _portfolio_summary() -> str:
    """Obtiene y formatea la cartera de TR."""
    if not _tr_client or not _tr_client.authenticated:
        return "⚠️ No autenticado en Trade Republic."
    try:
        await _tr_client.ensure_connected()
        positions = await _tr_client.get_portfolio()
        cash      = await _tr_client.get_cash()
        if not positions:
            return f"Cartera vacía. Saldo disponible: *{cash:.2f}€*"
        lines = [f"💼 *Cartera TR* — Saldo: *{cash:.2f}€*\n"]
        total = 0.0
        for p in positions:
            val   = p.get("value", 0)
            pnl   = p.get("pnl_pct", 0)
            arrow = "📈" if pnl >= 0 else "📉"
            total += val
            lines.append(f"{arrow} *{p.get('name','?')}*: {val:.0f}€ ({pnl:+.1f}%)")
        lines.append(f"\n📊 Total: *{total:.0f}€*")
        return "\n".join(lines)
    except Exception as e:
        return f"❌ Error: {e}"


# ── ISIN map para /sell ──────────────────────────────────────────────────────
# ISINs de los ETFs/acciones más comunes en Trade Republic España
_ISIN_MAP: dict[str, str] = {
    # ETFs globales
    "VWCE":  "IE00B3RBWM25",  "XEON":  "LU0290358497",
    "SPPW":  "IE00B3YCGJ38",  "EUNL":  "IE00B4L5Y983",
    "VUSA":  "IE00B3XXRP09",  "IEMA":  "IE00BKM4GZ66",
    "ZPRV":  "IE00BMT04N44",  "QDVE":  "IE00BYML9W36",
    "XDWD":  "IE00B3F81R35",  "IS3N":  "IE00B14X4T88",
    "EXXT":  "DE0002635307",  "IWDA":  "IE00B4L5Y983",
    # Renta fija
    "AGGU":  "IE00B3F81409",  "IBTS":  "IE00B14X4T88",
    "SXRM":  "IE00B3FH7618",  "VGOV":  "IE00B42WWV65",
    # Alternativos / materias primas
    "SGLN":  "IE00B579F325",  "BTCE":  "DE000A27Z304",
    "WGLD":  "DE000A2T6WD2",  "IAUM":  "IE00B579F325",
    # Acciones US
    "AAPL":  "US0378331005",  "MSFT":  "US5949181045",
    "NVDA":  "US67066G1040",  "AMZN":  "US0231351067",
    "GOOGL": "US02079K3059",  "TSLA":  "US88160R1014",
    "META":  "US30303M1027",  "NFLX":  "US64110L1061",
    # Acciones EU
    "ASML":  "NL0010273215",  "SAP":   "DE0007164600",
    "LVMH":  "FR0000121014",  "SAN":   "ES0113900J37",
    "IBE":   "ES0144580Y14",  "ITX":   "ES0148396007",
}

async def _execute_trades(trades: list[dict]) -> str:
    """Ejecuta una lista de trades [{ticker, isin, amount, name}] y devuelve resumen."""
    if not _tr_client or not _tr_client.authenticated:
        return "⚠️ No autenticado en Trade Republic."
    await _tr_client.ensure_connected()
    results = []
    for t in trades:
        try:
            await _tr_client.buy_cash_amount(t["isin"], t["amount"])
            results.append(f"✅ {t['ticker']}: {t['amount']:.0f}€ ejecutado")
        except Exception as e:
            results.append(f"❌ {t['ticker']}: {e}")
    return "\n".join(results)


# ── Comando /start ───────────────────────────────────────────────────────────

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _allowed(update):
        return
    await update.message.reply_text(
        "🏆 *AURUM — Tu gestor autónomo*\n\n"
        "Comandos disponibles:\n"
        "  /portfolio — Cartera y saldo TR\n"
        "  /cash — Saldo disponible\n"
        "  /market — Índices y mercados ahora\n"
        "  /price VWCE — Precio de cualquier ETF/acción\n"
        "  /invest 300 — Invertir 300€ ahora\n"
        "  /sell VWCE 500 — Vender 500€ de VWCE\n"
        "  /auto on|off — Modo autónomo\n"
        "  /auto status — Estado del auto-ciclo\n"
        "  /status — Estado del backend\n"
        "  /do <orden> — Ejecuta cualquier orden\n\n"
        "O simplemente escríbeme en lenguaje natural 👇",
        parse_mode=ParseMode.MARKDOWN,
    )


# ── Comando /portfolio ───────────────────────────────────────────────────────

async def cmd_portfolio(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _allowed(update):
        return
    msg = await update.message.reply_text("🔄 Obteniendo cartera…")
    summary = await _portfolio_summary()
    await msg.edit_text(summary, parse_mode=ParseMode.MARKDOWN)


# ── Comando /price <ticker> ──────────────────────────────────────────────────

_YAHOO_MAP: dict = {
    "VWCE": "VWCE.DE", "XEON": "XEON.DE", "SPPW": "SPPW.DE",
    "SGLN": "SGLN.DE", "EUNL": "EUNL.DE", "VUSA": "VUSA.L",
    "IEMA": "IEMA.DE", "ZPRV": "ZPRV.DE", "IUSE": "IUSE.DE",
    "VHYL": "VHYL.L",  "AGGU": "AGGU.L",  "IS3N": "IS3N.DE",
    "QDVE": "QDVE.DE", "XDWD": "XDWD.DE", "BTCE": "BTCE.DE",
}

async def _yahoo_price(ticker: str) -> float:
    """Precio de Yahoo Finance (0 tokens). Devuelve 0.0 si falla."""
    sym = _YAHOO_MAP.get(ticker.upper(), ticker.upper())
    url = f"https://query1.finance.yahoo.com/v7/finance/quote?symbols={sym}&fields=regularMarketPrice"
    try:
        async with httpx.AsyncClient(timeout=6, headers={"User-Agent": "Mozilla/5.0"}) as c:
            r = await c.get(url)
            q = r.json().get("quoteResponse", {}).get("result", [])
            return q[0].get("regularMarketPrice", 0.0) if q else 0.0
    except Exception:
        return 0.0


async def cmd_price(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """
    /price VWCE — precio en tiempo real desde Yahoo Finance.
    Si no está en Yahoo, usa Claude con web search.
    """
    if not _allowed(update):
        return
    args = context.args
    if not args:
        await update.message.reply_text(
            "Uso: /price TICKER\nEjemplos: /price VWCE · /price AAPL · /price BTC-EUR",
        )
        return

    ticker = args[0].upper().strip()
    msg    = await update.message.reply_text(f"🔍 Buscando precio de *{ticker}*…", parse_mode=ParseMode.MARKDOWN)

    # Intento 1: Yahoo Finance (gratis, 0 tokens)
    price = await _yahoo_price(ticker)

    if price:
        sym = _YAHOO_MAP.get(ticker, ticker)
        await msg.edit_text(
            f"📈 *{ticker}* — *{price:.2f}€*\n"
            f"_Fuente: Yahoo Finance ({sym})_",
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    # Intento 2: Claude con web search
    system = "Eres un asistente financiero. Responde SOLO en español con el precio actual, variación diaria y fuente."
    raw    = await _claude(system, f"¿Cuál es el precio actual de {ticker}? Dame precio, variación % y mercado.", max_tokens=300)
    await msg.edit_text(raw[:4096])


# ── Comando /sell <ticker> [importe|acciones] ────────────────────────────────

async def cmd_sell(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """
    /sell TICKER [IMPORTE_EUR]
    Ejemplos:
      /sell VWCE 500   → vende 500€ de VWCE
      /sell VWCE       → vende toda la posición de VWCE
    Si el ISIN no está en el mapa, se puede pasar como 2.º arg:
      /sell XXXX IE00XXXXXXXX 300
    """
    if not _allowed(update):
        return
    args = context.args
    if not args:
        await update.message.reply_text(
            "Uso: /sell TICKER [importe€]\n"
            "Ejemplos:\n"
            "  /sell VWCE 500  — vende 500€ de VWCE\n"
            "  /sell VWCE      — vende toda la posición",
        )
        return

    if not _tr_client or not _tr_client.authenticated:
        await update.message.reply_text("⚠️ No autenticado en Trade Republic.")
        return

    ticker     = args[0].upper().strip()
    isin       = _ISIN_MAP.get(ticker)
    amount_raw = None

    # Permite: /sell TICKER ISIN IMPORTE
    if len(args) >= 2 and len(args[1]) == 12 and args[1].isalnum():
        isin       = args[1].upper()
        amount_raw = args[2] if len(args) >= 3 else None
    elif len(args) >= 2:
        amount_raw = args[1]

    if not isin:
        await update.message.reply_text(
            f"❌ No conozco el ISIN de *{ticker}*.\n"
            "Pásalo manualmente: `/sell {ticker} ISIN_12CHARS [importe]`\n"
            "Consulta tu broker o usa el chat de AURUM.",
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    msg = await update.message.reply_text(
        f"📤 Preparando venta de *{ticker}*…", parse_mode=ParseMode.MARKDOWN
    )

    try:
        await _tr_client.ensure_connected()

        if amount_raw:
            # Vender importe en €
            amount = float(amount_raw.replace(",", ".").replace("€", ""))
            order  = await _tr_client.sell_cash_amount(isin, amount)
            desc   = f"{amount:.2f}€"
        else:
            # Vender toda la posición — obtener shares de la cartera
            positions = await _tr_client.get_portfolio()
            pos = next((p for p in positions if p.get("isin", "") == isin), None)
            if not pos:
                await msg.edit_text(
                    f"❌ No encontré *{ticker}* (ISIN: `{isin}`) en tu cartera TR.",
                    parse_mode=ParseMode.MARKDOWN,
                )
                return
            shares = pos.get("shares", 0)
            if not shares:
                await msg.edit_text(f"❌ {ticker} tiene 0 acciones en cartera.")
                return
            order = await _tr_client.sell_shares(isin, shares)
            desc  = f"todas ({shares} acc. · ≈{pos.get('value',0):.0f}€)"

        order_id = order.get("id", "—")
        await msg.edit_text(
            f"✅ *Venta ejecutada*\n\n"
            f"🏷 *{ticker}* — {desc}\n"
            f"ID orden: `{order_id}`",
            parse_mode=ParseMode.MARKDOWN,
        )
        logger.info(f"[Bot] Venta {ticker} ejecutada: {desc}")

    except Exception as e:
        logger.error(f"[Bot] /sell error: {e}")
        await msg.edit_text(f"❌ Error al vender {ticker}: {e}")


# ── Comando /market ──────────────────────────────────────────────────────────

_MARKET_INDICES = [
    ("^IBEX",    "IBEX 35"),
    ("^GSPC",    "S&P 500"),
    ("^IXIC",    "Nasdaq"),
    ("EURUSD=X", "EUR/USD"),
    ("BTC-EUR",  "Bitcoin"),
    ("GC=F",     "Oro"),
]

async def cmd_market(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """
    /market — snapshot de índices y mercados en tiempo real.
    """
    if not _allowed(update):
        return
    msg = await update.message.reply_text("📊 Obteniendo datos del mercado…")

    symbols_str = ",".join(s for s, _ in _MARKET_INDICES)
    url = (
        f"https://query1.finance.yahoo.com/v7/finance/quote"
        f"?symbols={symbols_str}"
        f"&fields=regularMarketPrice,regularMarketChangePercent,regularMarketTime"
    )
    try:
        async with httpx.AsyncClient(timeout=8, headers={"User-Agent": "Mozilla/5.0"}) as c:
            r = await c.get(url)
            r.raise_for_status()
            quotes = r.json().get("quoteResponse", {}).get("result", [])

        lines = ["📊 *Mercados ahora*\n"]
        for sym, name in _MARKET_INDICES:
            q = next((x for x in quotes if x.get("symbol") == sym), None)
            if not q:
                continue
            price = q.get("regularMarketPrice", 0)
            chg   = q.get("regularMarketChangePercent", 0)
            arrow = "📈" if chg >= 0 else "📉"
            # Formato según instrumento
            if sym == "EURUSD=X":
                price_str = f"{price:.4f}"
            elif price >= 10000:
                price_str = f"{price:,.0f}"
            else:
                price_str = f"{price:,.2f}"
            lines.append(f"{arrow} *{name}*: {price_str}  ({chg:+.2f}%)")

        lines.append(f"\n_Datos: Yahoo Finance · {__import__('datetime').datetime.now().strftime('%H:%M')}_")
        await msg.edit_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)

    except Exception as e:
        logger.error(f"[Bot] /market error: {e}")
        await msg.edit_text(f"❌ Error al obtener datos: {e}")


# ── Comando /cash ────────────────────────────────────────────────────────────

async def cmd_cash(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _allowed(update):
        return
    if not _tr_client or not _tr_client.authenticated:
        await update.message.reply_text("⚠️ No autenticado en Trade Republic.")
        return
    try:
        await _tr_client.ensure_connected()
        cash = await _tr_client.get_cash()
        await update.message.reply_text(f"💰 Saldo disponible: *{cash:.2f}€*", parse_mode=ParseMode.MARKDOWN)
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {e}")


# ── Comando /status ──────────────────────────────────────────────────────────

async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _allowed(update):
        return
    tr_ok    = "✅ Autenticado" if (_tr_client and _tr_client.authenticated) else "❌ No autenticado"
    auto_on  = _auto_cfg.get("enabled", False)
    last_run = _auto_cfg.get("last_run")
    last_str = last_run.strftime("%d/%m %H:%M") if last_run else "Nunca"
    await update.message.reply_text(
        f"⚙️ *Estado AURUM*\n\n"
        f"Trade Republic: {tr_ok}\n"
        f"Modo autónomo: {'🟢 Activo' if auto_on else '🔴 Inactivo'}\n"
        f"Última ejecución: {last_str}\n"
        f"Intervalo: {_auto_cfg.get('interval_hours', 168)}h\n"
        f"Presupuesto: {_auto_cfg.get('max_amount', 100):.0f}€/ciclo",
        parse_mode=ParseMode.MARKDOWN,
    )


# ── Comando /invest <amount> ─────────────────────────────────────────────────

async def cmd_invest(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _allowed(update):
        return

    # Parsea el importe
    args = context.args
    if not args:
        await update.message.reply_text("Uso: /invest <importe>\nEjemplo: /invest 500")
        return
    try:
        amount = float(args[0].replace(",", ".").replace("€", ""))
    except ValueError:
        await update.message.reply_text("❌ Importe inválido. Ejemplo: /invest 300")
        return
    if amount < 10:
        await update.message.reply_text("❌ Importe mínimo: 10€")
        return

    msg = await update.message.reply_text(f"🧠 AURUM analizando mercados para invertir {amount:.0f}€…")

    try:
        positions = []
        cash      = amount
        if _tr_client and _tr_client.authenticated:
            await _tr_client.ensure_connected()
            positions = await _tr_client.get_portfolio()
            cash_avail = await _tr_client.get_cash()
            if cash_avail < amount:
                await msg.edit_text(
                    f"⚠️ Saldo insuficiente: {cash_avail:.2f}€ disponible, solicitaste {amount:.0f}€.",
                    parse_mode=ParseMode.MARKDOWN,
                )
                return

        portfolio_str = ", ".join(
            f"{p.get('name','?')}({p.get('value',0):.0f}€)" for p in positions
        ) or "vacía"

        system = (
            "Eres AURUM, gestor de inversiones. El usuario quiere invertir desde Telegram. "
            "Usa búsqueda web para el estado actual del mercado. "
            "Responde SOLO con JSON válido:\n"
            '{"trades":[{"ticker":"VWCE","isin":"IE00B3RBWM25","name":"Vanguard FTSE All-World","amount":300}],'
            '"rationale":"razón breve","marketContext":"contexto mercado"}'
        )
        user_msg = (
            f"Invertir {amount:.0f}€ ahora. Cartera actual: {portfolio_str}. "
            "Decide la mejor distribución y devuelve SOLO JSON."
        )

        raw = await _claude(system, user_msg, max_tokens=1024)
        match = __import__("re").search(r"\{[\s\S]*\}", raw)
        if not match:
            raise ValueError("JSON no encontrado en respuesta de Claude")
        plan = json.loads(match.group())
        trades = plan.get("trades", [])

        if not trades:
            await msg.edit_text("🤔 AURUM decidió no invertir en este momento.", parse_mode=ParseMode.MARKDOWN)
            return

        # Muestra el plan
        trades_preview = "\n".join(f"  • *{t['ticker']}*: {t['amount']:.0f}€" for t in trades)
        await msg.edit_text(
            f"📋 *Plan de inversión — {amount:.0f}€*\n\n"
            f"{trades_preview}\n\n"
            f"_{plan.get('rationale','')}_\n\n"
            "Ejecutando en Trade Republic…",
            parse_mode=ParseMode.MARKDOWN,
        )

        result = await _execute_trades(trades)
        await update.message.reply_text(
            f"✅ *Órdenes ejecutadas*\n\n{result}",
            parse_mode=ParseMode.MARKDOWN,
        )

    except Exception as e:
        logger.error(f"[Bot] /invest error: {e}")
        await msg.edit_text(f"❌ Error: {e}")


# ── Comando /auto ────────────────────────────────────────────────────────────

async def cmd_auto(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _allowed(update):
        return
    args = context.args

    if not args or args[0].lower() == "status":
        await cmd_status(update, context)
        return

    action = args[0].lower()
    if action == "on":
        _auto_cfg["enabled"] = True
        await update.message.reply_text(
            "🟢 *Modo autónomo activado.*\n"
            f"AURUM invertirá automáticamente cada {_auto_cfg.get('interval_hours',168)}h.",
            parse_mode=ParseMode.MARKDOWN,
        )
    elif action == "off":
        _auto_cfg["enabled"] = False
        await update.message.reply_text("🔴 *Modo autónomo desactivado.*", parse_mode=ParseMode.MARKDOWN)
    else:
        await update.message.reply_text("Uso: /auto on | /auto off | /auto status")


# ── Comando /do <orden en lenguaje natural> ──────────────────────────────────

async def cmd_do(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _allowed(update):
        return
    command_text = " ".join(context.args) if context.args else ""
    if not command_text:
        await update.message.reply_text(
            "Uso: /do <orden>\nEjemplos:\n"
            "  /do invierte 200€ en VWCE\n"
            "  /do ¿cómo está mi cartera?\n"
            "  /do activa el modo autónomo con 150€ por semana"
        )
        return
    await _handle_natural_language(update, command_text, force_action=True)


# ── Mensajes de texto libre ──────────────────────────────────────────────────

async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not _allowed(update):
        return
    text = update.message.text or ""
    await _handle_natural_language(update, text, force_action=False)


# ── Intérprete de lenguaje natural ───────────────────────────────────────────

_INTENT_SYSTEM = """\
Eres AURUM, asesor financiero autónomo que opera desde Telegram.
Analiza el mensaje del usuario e identifica la intención.

Intenciones posibles:
- "invest": quiere invertir dinero (extrae amount en €)
- "sell": quiere vender una posición (extrae ticker y amount o "all")
- "portfolio": quiere ver su cartera o saldo
- "market": quiere ver índices de mercado (IBEX, S&P, Bitcoin, etc.)
- "price": quiere saber el precio de un ticker específico (extrae ticker)
- "auto_on": quiere activar modo autónomo
- "auto_off": quiere desactivar modo autónomo
- "status": quiere saber el estado del sistema
- "computer": quiere que AURUM controle su PC o navegador
- "advise": pregunta financiera o de mercado (responde como asesor)
- "other": otra cosa

Responde SOLO con JSON:
{"intent":"invest","amount":300,"reply":"Voy a invertir 300€ ahora mismo."}
{"intent":"sell","ticker":"VWCE","amount":500,"reply":"Voy a vender 500€ de VWCE."}
{"intent":"sell","ticker":"AAPL","amount":"all","reply":"Venderé toda tu posición de AAPL."}
{"intent":"market","reply":"Consultando mercados..."}
{"intent":"price","ticker":"NVDA","reply":"Buscando precio de NVDA..."}
{"intent":"portfolio","reply":"Déjame ver tu cartera."}
{"intent":"computer","task":"descripción exacta de lo que debe hacer AURUM en el PC","reply":"Voy a controlar tu PC..."}
{"intent":"advise","reply":"<respuesta completa al usuario en español>"}
"""


async def _handle_natural_language(update: Update, text: str, force_action: bool) -> None:
    msg = await update.message.reply_text("🔄 Procesando…")
    try:
        raw = await _claude(_INTENT_SYSTEM, text, max_tokens=600)
        match = __import__("re").search(r"\{[\s\S]*?\}", raw)
        if not match:
            # Si no hay JSON, responde directamente
            await msg.edit_text(raw[:4096])
            return

        data   = json.loads(match.group())
        intent = data.get("intent", "other")
        reply  = data.get("reply", "")

        if intent == "portfolio":
            await msg.edit_text("🔄 Obteniendo cartera…")
            summary = await _portfolio_summary()
            await msg.edit_text(summary, parse_mode=ParseMode.MARKDOWN)

        elif intent == "market":
            await msg.edit_text("📊 Consultando mercados…")
            await cmd_market(update, context)
            await msg.delete()

        elif intent == "price":
            ticker_p = data.get("ticker", "")
            if ticker_p:
                context_mock_args = type("C", (), {"args": [ticker_p]})()
                await msg.edit_text(f"🔍 Buscando precio de *{ticker_p}*…", parse_mode=ParseMode.MARKDOWN)
                price = await _yahoo_price(ticker_p)
                if price:
                    sym = _YAHOO_MAP.get(ticker_p.upper(), ticker_p.upper())
                    await msg.edit_text(
                        f"📈 *{ticker_p}* — *{price:.2f}€*\n_Fuente: Yahoo Finance ({sym})_",
                        parse_mode=ParseMode.MARKDOWN,
                    )
                else:
                    raw_p = await _claude(
                        "Eres un asistente financiero. Responde SOLO en español con el precio actual.",
                        f"Precio actual de {ticker_p}.", max_tokens=250,
                    )
                    await msg.edit_text(raw_p[:4096])
            else:
                await msg.edit_text(reply[:4096] if reply else "¿De qué ticker quieres el precio?")

        elif intent == "sell":
            ticker_s = data.get("ticker", "")
            amount_s = data.get("amount")
            if not ticker_s:
                await msg.edit_text(f"{reply}\n\n⚠️ No detecto el ticker. Usa /sell TICKER [importe]")
                return
            await msg.edit_text(f"{reply}\n\n📤 Procesando venta de *{ticker_s}*…", parse_mode=ParseMode.MARKDOWN)
            isin_s = _ISIN_MAP.get(ticker_s.upper())
            if not isin_s:
                await msg.edit_text(
                    f"❌ ISIN de *{ticker_s}* no encontrado en mi mapa.\n"
                    f"Usa: /sell {ticker_s} [importe] para especificarlo.",
                    parse_mode=ParseMode.MARKDOWN,
                )
                return
            if not _tr_client or not _tr_client.authenticated:
                await msg.edit_text("⚠️ No autenticado en Trade Republic.")
                return
            try:
                await _tr_client.ensure_connected()
                if amount_s == "all" or not amount_s:
                    positions = await _tr_client.get_portfolio()
                    pos_s = next((p for p in positions if p.get("isin", "") == isin_s), None)
                    if not pos_s:
                        await msg.edit_text(f"❌ No encontré *{ticker_s}* en tu cartera.", parse_mode=ParseMode.MARKDOWN)
                        return
                    order = await _tr_client.sell_shares(isin_s, pos_s.get("shares", 0))
                    desc_s = f"toda la posición ({pos_s.get('shares',0)} acc.)"
                else:
                    amt_f = float(str(amount_s).replace(",", ".").replace("€", ""))
                    order = await _tr_client.sell_cash_amount(isin_s, amt_f)
                    desc_s = f"{amt_f:.0f}€"
                await msg.edit_text(
                    f"✅ *Venta ejecutada*\n🏷 *{ticker_s}* — {desc_s}\nID: {order.get('id','—')}",
                    parse_mode=ParseMode.MARKDOWN,
                )
            except Exception as e_s:
                await msg.edit_text(f"❌ Error al vender {ticker_s}: {e_s}")

        elif intent == "invest":
            amount = float(data.get("amount", 0))
            if amount < 10:
                await msg.edit_text(f"{reply}\n\n⚠️ Importe no detectado o insuficiente. Usa /invest 300")
                return
            await msg.edit_text(f"{reply}\n\n🧠 Analizando mercados…")
            # Reutiliza la lógica de /invest
            context_mock = type("C", (), {"args": [str(amount)]})()
            update.message.text = f"/invest {amount}"
            # Lógica directa sin mock
            try:
                positions = []
                if _tr_client and _tr_client.authenticated:
                    await _tr_client.ensure_connected()
                    positions = await _tr_client.get_portfolio()
                    cash_avail = await _tr_client.get_cash()
                    if cash_avail < amount:
                        await msg.edit_text(
                            f"⚠️ Saldo insuficiente: {cash_avail:.2f}€ disponible.",
                            parse_mode=ParseMode.MARKDOWN,
                        )
                        return
                portfolio_str = ", ".join(
                    f"{p.get('name','?')}({p.get('value',0):.0f}€)" for p in positions
                ) or "vacía"
                system = (
                    "Eres AURUM. Usa búsqueda web para estado del mercado. "
                    "SOLO JSON: {\"trades\":[{\"ticker\":\"VWCE\",\"isin\":\"IE00B3RBWM25\","
                    "\"name\":\"Vanguard FTSE All-World\",\"amount\":300}],"
                    "\"rationale\":\"razón breve\"}"
                )
                raw2 = await _claude(system, f"Invertir {amount:.0f}€. Cartera: {portfolio_str}. SOLO JSON.", 1024)
                m2 = __import__("re").search(r"\{[\s\S]*\}", raw2)
                if not m2:
                    raise ValueError("Sin JSON de inversión")
                plan   = json.loads(m2.group())
                trades = plan.get("trades", [])
                if not trades:
                    await msg.edit_text("🤔 AURUM decidió no invertir ahora.")
                    return
                preview = "\n".join(f"  • *{t['ticker']}*: {t['amount']:.0f}€" for t in trades)
                await msg.edit_text(
                    f"📋 *Plan — {amount:.0f}€*\n{preview}\n\n_{plan.get('rationale','')}_\n\nEjecutando…",
                    parse_mode=ParseMode.MARKDOWN,
                )
                result = await _execute_trades(trades)
                await update.message.reply_text(f"✅ *Órdenes ejecutadas*\n{result}", parse_mode=ParseMode.MARKDOWN)
            except Exception as e:
                await msg.edit_text(f"❌ Error ejecutando inversión: {e}")

        elif intent == "auto_on":
            _auto_cfg["enabled"] = True
            amount = float(data.get("amount", _auto_cfg.get("max_amount", 100)))
            if amount > 0:
                _auto_cfg["max_amount"] = amount
            await msg.edit_text(
                f"🟢 *Modo autónomo activado* — máx {_auto_cfg['max_amount']:.0f}€/ciclo",
                parse_mode=ParseMode.MARKDOWN,
            )

        elif intent == "auto_off":
            _auto_cfg["enabled"] = False
            await msg.edit_text("🔴 *Modo autónomo desactivado.*", parse_mode=ParseMode.MARKDOWN)

        elif intent == "status":
            tr_ok   = "✅" if (_tr_client and _tr_client.authenticated) else "❌"
            auto_on = _auto_cfg.get("enabled", False)
            await msg.edit_text(
                f"⚙️ TR: {tr_ok} | Auto: {'🟢' if auto_on else '🔴'} | "
                f"Saldo máx: {_auto_cfg.get('max_amount',100):.0f}€",
                parse_mode=ParseMode.MARKDOWN,
            )

        elif intent == "computer":
            task = data.get("task", text)
            await msg.edit_text(f"🖥️ Controlando tu PC…\n_{task}_", parse_mode=ParseMode.MARKDOWN)
            try:
                # Intenta agente local primero, luego Playwright en servidor
                import httpx as _httpx
                from computer_agent import get_agent
                agent = get_agent(headless=True)
                result = await agent.run_task(task, max_steps=20)
                status_icon = "✅" if result["success"] else "❌"
                resp = (
                    f"{status_icon} *Tarea completada*\n\n"
                    f"{result.get('result','')[:800]}\n\n"
                    f"_Pasos: {result.get('steps',0)}_"
                )
                await msg.edit_text(resp, parse_mode=ParseMode.MARKDOWN)
            except Exception as e:
                await msg.edit_text(f"❌ Error controlando PC: {e}")

        elif intent == "advise":
            await msg.edit_text(reply[:4096])

        else:
            if reply:
                await msg.edit_text(reply[:4096])
            else:
                await msg.edit_text("No entendí la orden. Prueba /do o escríbeme más claro.")

    except Exception as e:
        logger.error(f"[Bot] NL error: {e}")
        await msg.edit_text(f"❌ Error: {e}")


# ── Lifecycle ────────────────────────────────────────────────────────────────

async def start_bot(token: str, tr_client, auto_cfg: dict) -> Application:
    """
    Arranca el bot. Llamar desde el lifespan de FastAPI.
    Devuelve el Application para poder detenerlo en shutdown.
    """
    global _tr_client, _auto_cfg, _bot_app
    _tr_client = tr_client
    _auto_cfg  = auto_cfg  # referencia compartida — las modificaciones son visibles en main.py

    app = Application.builder().token(token).build()

    app.add_handler(CommandHandler("start",     cmd_start))
    app.add_handler(CommandHandler("portfolio", cmd_portfolio))
    app.add_handler(CommandHandler("cash",      cmd_cash))
    app.add_handler(CommandHandler("market",    cmd_market))
    app.add_handler(CommandHandler("price",     cmd_price))
    app.add_handler(CommandHandler("sell",      cmd_sell))
    app.add_handler(CommandHandler("status",    cmd_status))
    app.add_handler(CommandHandler("invest",    cmd_invest))
    app.add_handler(CommandHandler("auto",      cmd_auto))
    app.add_handler(CommandHandler("do",        cmd_do))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))

    await app.bot.set_my_commands([
        BotCommand("start",     "Presentación y ayuda"),
        BotCommand("portfolio", "Ver cartera y saldo TR"),
        BotCommand("cash",      "Saldo disponible"),
        BotCommand("market",    "Índices y mercados en tiempo real"),
        BotCommand("price",     "Precio en tiempo real (ej: /price VWCE)"),
        BotCommand("sell",      "Vender posición (ej: /sell VWCE 500)"),
        BotCommand("invest",    "Invertir N€ ahora (ej: /invest 300)"),
        BotCommand("auto",      "Modo autónomo on/off"),
        BotCommand("status",    "Estado del sistema"),
        BotCommand("do",        "Orden en lenguaje natural"),
    ])

    await app.initialize()
    await app.start()
    await app.updater.start_polling(allowed_updates=["message"])
    logger.info("✅ AURUM Telegram Bot iniciado.")
    _bot_app = app
    return app


async def stop_bot() -> None:
    """Detiene el bot limpiamente."""
    if _bot_app:
        await _bot_app.updater.stop()
        await _bot_app.stop()
        await _bot_app.shutdown()
        logger.info("AURUM Telegram Bot detenido.")
