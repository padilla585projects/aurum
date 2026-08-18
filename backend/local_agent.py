#!/usr/bin/env python3
"""
AURUM Local Agent — Control del PC/móvil del usuario.

Corre en el PC o teléfono del usuario (NO en el servidor).
Se conecta al backend AURUM y ejecuta comandos localmente:
  - Abrir aplicaciones
  - Tomar screenshots
  - Mover el ratón y escribir (pyautogui)
  - Controlar el navegador local

Uso:
  pip install pyautogui mss httpx pillow
  python local_agent.py --server https://mi-aurum.tailscale.net --key MI_API_KEY

El backend envía comandos, el agente los ejecuta y reporta resultados.
"""

import argparse
import asyncio
import base64
import io
import json
import logging
import os
import platform
import subprocess
import sys
import time
from typing import Any, Optional

import httpx

try:
    import pyautogui
    pyautogui.FAILSAFE = True
    pyautogui.PAUSE    = 0.3
    HAS_PYAUTOGUI = True
except ImportError:
    HAS_PYAUTOGUI = False

try:
    import mss
    HAS_MSS = True
except ImportError:
    HAS_MSS = False

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

OS = platform.system()  # Windows / Darwin / Linux


# ── Screenshot ───────────────────────────────────────────────────────────────

def take_screenshot() -> str:
    """Toma screenshot y devuelve base64 PNG."""
    if HAS_MSS:
        with mss.mss() as sct:
            monitor = sct.monitors[1]
            raw     = sct.grab(monitor)
            from PIL import Image
            img  = Image.frombytes("RGB", raw.size, raw.bgra, "raw", "BGRX")
            buf  = io.BytesIO()
            img.save(buf, format="PNG")
            return base64.b64encode(buf.getvalue()).decode()
    elif HAS_PYAUTOGUI:
        img = pyautogui.screenshot()
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode()
    return ""


# ── OS actions ───────────────────────────────────────────────────────────────

def open_app(app_name: str) -> str:
    """Abre una aplicación de una lista cerrada, sin invocar un shell."""
    name_lower = app_name.lower()
    common = {
        "chrome": "chrome",
        "firefox": "firefox",
        "edge": "msedge",
        "calculator": "calc",
        "notepad": "notepad",
        "explorer": "explorer",
    }
    exe = common.get(name_lower)
    if not exe:
        return f"❌ Aplicación no permitida: {app_name}"
    try:
        if OS == "Windows":
            subprocess.Popen(["cmd", "/c", "start", "", exe])
        elif OS == "Darwin":
            subprocess.Popen(["open", "-a", exe])
        else:
            subprocess.Popen([exe])
        return f"✅ {app_name} abierto"
    except Exception as e:
        return f"❌ No se pudo abrir {app_name}: {e}"


def mouse_click(x: int, y: int, button: str = "left", clicks: int = 1) -> str:
    if not HAS_PYAUTOGUI:
        return "❌ pyautogui no instalado"
    try:
        pyautogui.click(x, y, button=button, clicks=clicks)
        return f"✅ Click en ({x},{y})"
    except Exception as e:
        return f"❌ {e}"


def mouse_move(x: int, y: int) -> str:
    if not HAS_PYAUTOGUI:
        return "❌ pyautogui no instalado"
    try:
        pyautogui.moveTo(x, y, duration=0.3)
        return f"✅ Movido a ({x},{y})"
    except Exception as e:
        return f"❌ {e}"


def keyboard_type(text: str) -> str:
    """
    Escribe texto. Usa el portapapeles para soporte completo de unicode
    (tildes, ñ, €, emojis, etc.). Requiere pyperclip o xclip/xdotool en Linux.
    """
    if not HAS_PYAUTOGUI:
        return "❌ pyautogui no instalado"
    try:
        # Intenta vía portapapeles para soporte completo de unicode
        try:
            import pyperclip
            pyperclip.copy(text)
            pyautogui.hotkey("ctrl", "v")
            return "✅ Texto escrito (portapapeles)"
        except ImportError:
            pass
        # Fallback: typewrite solo soporta ASCII
        safe = "".join(c if ord(c) < 128 else "?" for c in text)
        pyautogui.typewrite(safe, interval=0.05)
        return "✅ Texto escrito (ASCII)"
    except Exception as e:
        return f"❌ {e}"


def keyboard_hotkey(*keys: str) -> str:
    if not HAS_PYAUTOGUI:
        return "❌ pyautogui no instalado"
    try:
        pyautogui.hotkey(*keys)
        return f"✅ Hotkey {'+'.join(keys)}"
    except Exception as e:
        return f"❌ {e}"


def open_url(url: str) -> str:
    """Abre una URL en el navegador por defecto."""
    import webbrowser
    try:
        webbrowser.open(url)
        return f"✅ URL abierta: {url}"
    except Exception as e:
        return f"❌ {e}"


# ── Command dispatcher ───────────────────────────────────────────────────────

def execute_local_command(cmd: dict) -> Any:
    """
    Ejecuta un comando local y devuelve el resultado.

    cmd es un dict con:
      type: "screenshot"|"open_app"|"click"|"move"|"type"|"hotkey"|"open_url"
      + parámetros específicos del tipo
    """
    t = cmd.get("type", "")

    if t == "screenshot":
        b64 = take_screenshot()
        return {"screenshot_b64": b64, "ok": bool(b64)}

    elif t == "open_app":
        return {"result": open_app(cmd.get("app", "")), "ok": True}

    elif t == "click":
        return {"result": mouse_click(cmd.get("x",0), cmd.get("y",0), cmd.get("button","left"), cmd.get("clicks",1)), "ok": True}

    elif t == "move":
        return {"result": mouse_move(cmd.get("x",0), cmd.get("y",0)), "ok": True}

    elif t == "type":
        return {"result": keyboard_type(cmd.get("text","")), "ok": True}

    elif t == "hotkey":
        keys = cmd.get("keys", [])
        return {"result": keyboard_hotkey(*keys), "ok": True}

    elif t == "open_url":
        return {"result": open_url(cmd.get("url","")), "ok": True}

    elif t == "scroll":
        if not HAS_PYAUTOGUI:
            return {"result": "❌ pyautogui no instalado", "ok": False}
        try:
            pyautogui.scroll(cmd.get("clicks", -3), x=cmd.get("x"), y=cmd.get("y"))
            return {"result": "✅ Scroll ejecutado", "ok": True}
        except Exception as e:
            return {"result": f"❌ {e}", "ok": False}

    else:
        return {"result": f"Comando desconocido: {t}", "ok": False}


# ── Polling loop ─────────────────────────────────────────────────────────────

async def poll_loop(server: str, api_key: str, poll_interval: float = 2.0):
    """
    Polling loop principal.
    1. GET /agent/poll → recibe comando pendiente (o {"pending": false})
    2. Ejecuta el comando localmente
    3. POST /agent/result → envía resultado
    """
    base    = server.rstrip("/")
    headers = {"X-AURUM-KEY": api_key, "Content-Type": "application/json"}

    logger.info(f"AURUM Local Agent iniciado — servidor: {base}")
    logger.info(f"OS: {OS} | pyautogui: {HAS_PYAUTOGUI} | mss: {HAS_MSS}")

    # Registro en el servidor
    async with httpx.AsyncClient(timeout=10) as c:
        try:
            r = await c.post(f"{base}/agent/register", headers=headers, json={
                "os":          OS,
                "pyautogui":   HAS_PYAUTOGUI,
                "mss":         HAS_MSS,
                "capabilities": ["screenshot","open_app","click","move","type","hotkey","open_url","scroll"],
            })
            logger.info(f"Registrado en backend: {r.status_code}")
        except Exception as e:
            logger.warning(f"No se pudo registrar (backend puede no estar listo aún): {e}")

    async with httpx.AsyncClient(timeout=15) as client:
        while True:
            try:
                # Solicita comando pendiente
                r = await client.get(f"{base}/agent/poll", headers=headers)
                if r.status_code == 200:
                    data = r.json()
                    if data.get("pending"):
                        cmd_id  = data["id"]
                        cmd     = data["command"]
                        logger.info(f"Ejecutando comando #{cmd_id}: {cmd}")

                        # Ejecutar
                        try:
                            result = execute_local_command(cmd)
                        except Exception as e:
                            result = {"error": str(e), "ok": False}

                        # Reportar resultado
                        await client.post(
                            f"{base}/agent/result",
                            headers=headers,
                            json={"id": cmd_id, "result": result},
                        )
                        logger.info(f"Resultado #{cmd_id} enviado: {str(result)[:100]}")
                        continue  # No esperar si hay trabajo pendiente

            except httpx.ConnectError:
                logger.warning("No se puede conectar al servidor. Reintentando…")
            except Exception as e:
                logger.error(f"Error en poll loop: {e}")

            await asyncio.sleep(poll_interval)


# ── Entry point ──────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="AURUM Local Agent")
    parser.add_argument("--server",   required=True,  help="URL del backend AURUM (ej: https://aurum.tailscale.net)")
    parser.add_argument("--key",      required=True,  help="API key del backend")
    parser.add_argument("--interval", type=float, default=2.0, help="Segundos entre polls (defecto: 2)")
    args = parser.parse_args()

    print(f"""
╔══════════════════════════════════════════════════╗
║          AURUM Local Agent v1.0                 ║
║  Controlando tu PC desde el backend AURUM       ║
╚══════════════════════════════════════════════════╝
Servidor : {args.server}
OS       : {OS}
pyautogui: {'✅' if HAS_PYAUTOGUI else '❌ (pip install pyautogui)'}
mss      : {'✅' if HAS_MSS else '❌ (pip install mss pillow)'}

Presiona Ctrl+C para detener.
""")

    asyncio.run(poll_loop(args.server, args.key, args.interval))
