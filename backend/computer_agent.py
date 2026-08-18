"""
AURUM Computer Agent — Control autónomo de navegadores y servicios financieros.

Usa Playwright + Claude Vision para:
  - Navegar a cualquier web financiera (banco, broker, etc.)
  - Extraer saldos, posiciones, movimientos
  - Ejecutar transferencias, órdenes, pagos
  - Loop Claude-visión: screenshot → Claude decide acción → ejecuta → repite

Corre en el servidor (headless) o en el PC del usuario (headed).
"""

import asyncio
import base64
import json
import logging
import os
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

ANTHROPIC_KEY = os.getenv("ANTHROPIC_API_KEY", "")

_VISION_SYSTEM = """\
Eres AURUM, agente de control de navegador. Se te da una captura de pantalla de un navegador y una tarea.
Decide la siguiente acción a ejecutar. Responde SOLO con JSON:

Para hacer click: {"action":"click","x":120,"y":450,"reason":"..."}
Para escribir texto: {"action":"type","text":"mi texto","reason":"..."}
Para escribir la credencial disponible en el campo ya enfocado: {"action":"type_username","reason":"..."} o {"action":"type_password","reason":"..."}
Para presionar tecla: {"action":"key","key":"Enter","reason":"..."}
Para navegar a URL: {"action":"navigate","url":"https://...","reason":"..."}
Para hacer scroll: {"action":"scroll","x":400,"y":300,"delta":-300,"reason":"..."}
Para esperar (ms): {"action":"wait","ms":1500,"reason":"..."}
Para reportar resultado: {"action":"done","result":"texto del resultado extraído","success":true}
Para reportar error: {"action":"done","result":"descripción del error","success":false}

Reglas:
- Nunca inventes datos. Solo extrae lo que ves en pantalla.
- Si necesitas credenciales y no las tienes, reporta done con el problema.
- Nunca pidas, repitas ni incluyas credenciales en la respuesta. Usa type_username o type_password únicamente cuando el campo correcto esté enfocado.
- Máximo 25 pasos por tarea.
- Si detectas un captcha, reporta done con "captcha detectado".
"""


class ComputerAgent:
    def __init__(self, headless: bool = True):
        self.headless  = headless
        self._browser  = None
        self._page     = None
        self._playwright = None

    async def _ensure_browser(self):
        if self._page and not self._page.is_closed():
            return
        from playwright.async_api import async_playwright
        self._playwright = await async_playwright().start()
        self._browser    = await self._playwright.chromium.launch(
            headless=self.headless,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        self._page = await self._browser.new_page(
            viewport={"width": 1280, "height": 800},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/125.0.0.0 Safari/537.36"
            ),
        )

    async def _screenshot_b64(self) -> str:
        """Toma screenshot y devuelve base64 PNG."""
        raw = await self._page.screenshot(type="png", full_page=False)
        return base64.b64encode(raw).decode()

    async def _claude_vision(self, task: str, screenshot_b64: str, history: list) -> dict:
        """Llama a Claude con la screenshot para decidir la siguiente acción."""
        if not ANTHROPIC_KEY:
            return {"action": "done", "result": "ANTHROPIC_API_KEY no configurada", "success": False}

        messages = list(history) + [{
            "role": "user",
            "content": [
                {
                    "type":   "image",
                    "source": {"type": "base64", "media_type": "image/png", "data": screenshot_b64},
                },
                {"type": "text", "text": f"Tarea actual: {task}\n\n¿Cuál es la siguiente acción?"},
            ],
        }]

        async with httpx.AsyncClient(timeout=45) as client:
            r = await client.post(
                "https://api.anthropic.com/v1/messages",
                headers={
                    "x-api-key":         ANTHROPIC_KEY,
                    "anthropic-version": "2023-06-01",
                    "Content-Type":      "application/json",
                },
                json={
                    "model":      "claude-sonnet-4-6",
                    "max_tokens": 512,
                    "system":     _VISION_SYSTEM,
                    "messages":   messages,
                },
            )
            r.raise_for_status()
            data = r.json()

        text = " ".join(
            b["text"] for b in data.get("content", []) if b.get("type") == "text"
        ).strip()

        import re
        m = re.search(r"\{[\s\S]*?\}", text)
        if not m:
            return {"action": "done", "result": f"Respuesta inesperada: {text}", "success": False}
        try:
            return json.loads(m.group())
        except json.JSONDecodeError:
            return {"action": "done", "result": "JSON inválido de Claude", "success": False}

    async def run_task(
        self,
        task: str,
        start_url: Optional[str] = None,
        max_steps: int = 25,
        credentials: Optional[dict] = None,
    ) -> dict:
        """
        Ejecuta una tarea en el navegador con el loop Claude-visión.

        Args:
            task: Descripción de la tarea en lenguaje natural.
            start_url: URL de inicio (opcional).
            max_steps: Máximo número de acciones.
            credentials: {"username":"...","password":"..."} para la tarea.

        Returns:
            {"success": bool, "result": str, "steps": int, "screenshot_b64": str}
        """
        await self._ensure_browser()

        if start_url:
            await self._page.goto(start_url, wait_until="domcontentloaded", timeout=20000)
            await asyncio.sleep(1.5)

        if credentials:
            # Los secretos no se incluyen en el prompt, las capturas ni el
            # historial enviado al proveedor de IA.
            available = []
            if credentials.get("username"):
                available.append("usuario")
            if credentials.get("password"):
                available.append("contraseña")
            task += f"\nCredenciales disponibles: {', '.join(available)}."

        history: list = []
        last_screenshot = ""

        for step in range(max_steps):
            try:
                screenshot_b64 = await self._screenshot_b64()
                last_screenshot = screenshot_b64
            except Exception as e:
                return {"success": False, "result": f"Screenshot error: {e}", "steps": step}

            action_data = await self._claude_vision(task, screenshot_b64, history)
            logger.info(f"[Computer] Step {step+1}: {action_data}")

            # Añade al historial
            history.append({
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": screenshot_b64}},
                    {"type": "text",  "text": f"Tarea: {task}\n¿Siguiente acción?"},
                ],
            })
            history.append({
                "role": "assistant",
                "content": json.dumps(action_data, ensure_ascii=False),
            })
            # Limita historial para no explotar contexto
            if len(history) > 10:
                history = history[-10:]

            action = action_data.get("action", "done")

            if action == "done":
                return {
                    "success":        action_data.get("success", True),
                    "result":         action_data.get("result", ""),
                    "steps":          step + 1,
                    "screenshot_b64": last_screenshot,
                }

            try:
                if action == "navigate":
                    await self._page.goto(action_data["url"], wait_until="domcontentloaded", timeout=20000)
                    await asyncio.sleep(1.5)

                elif action == "click":
                    await self._page.mouse.click(action_data["x"], action_data["y"])
                    await asyncio.sleep(0.8)

                elif action == "type":
                    await self._page.keyboard.type(action_data["text"], delay=50)
                    await asyncio.sleep(0.5)

                elif action == "type_username":
                    username = (credentials or {}).get("username")
                    if not username:
                        return {"success": False, "result": "Usuario no disponible", "steps": step + 1}
                    await self._page.keyboard.type(username, delay=50)
                    await asyncio.sleep(0.5)

                elif action == "type_password":
                    password = (credentials or {}).get("password")
                    if not password:
                        return {"success": False, "result": "Contraseña no disponible", "steps": step + 1}
                    await self._page.keyboard.type(password, delay=50)
                    await asyncio.sleep(0.5)

                elif action == "key":
                    await self._page.keyboard.press(action_data["key"])
                    await asyncio.sleep(0.6)

                elif action == "scroll":
                    await self._page.mouse.move(action_data.get("x", 640), action_data.get("y", 400))
                    await self._page.mouse.wheel(0, action_data.get("delta", -300))
                    await asyncio.sleep(0.5)

                elif action == "wait":
                    await asyncio.sleep(action_data.get("ms", 1000) / 1000)

            except Exception as e:
                logger.warning(f"[Computer] Action error at step {step+1}: {e}")
                # Continúa — Claude verá el estado actual en el siguiente screenshot

        return {
            "success":        False,
            "result":         f"Límite de {max_steps} pasos alcanzado sin completar la tarea.",
            "steps":          max_steps,
            "screenshot_b64": last_screenshot,
        }

    async def close(self):
        if self._browser:
            await self._browser.close()
        if self._playwright:
            await self._playwright.stop()
        self._page = None
        self._browser = None
        self._playwright = None


# ── Singleton (una instancia por proceso del servidor) ───────────────────────
_agent: Optional[ComputerAgent] = None


def get_agent(headless: bool = True) -> ComputerAgent:
    global _agent
    if _agent is None:
        _agent = ComputerAgent(headless=headless)
    return _agent


async def close_agent():
    global _agent
    if _agent:
        await _agent.close()
        _agent = None
