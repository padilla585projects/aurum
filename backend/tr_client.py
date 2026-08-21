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
import base64
import json
import re
import logging
from typing import Any, Optional

import httpx
import websockets
from websockets.exceptions import ConnectionClosed

logger = logging.getLogger(__name__)

WS_URL = "wss://api.traderepublic.com"

# Version del protocolo que se anuncia en el saludo. Comprobado contra el
# servidor real: 30 y 31 responden igual.
WS_VERSION = 31

API_URL = "https://api.traderepublic.com"

# La v2 exige identificarse como cliente. Sin estas cabeceras TR responde
# MISSING_REQUIRED_HEADER antes de mirar siquiera el cuerpo.
APP_VERSION = "3.151.3"
DEVICE_INFO = base64.b64encode(json.dumps({
    "platform":   "web-pro",
    "osVersion":  "chrome - 125.0.0",
    "appVersion": APP_VERSION,
}).encode()).decode()

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
        self._accion:        Optional[str] = None
        self._sesion_http:   Optional[httpx.AsyncClient] = None
        self._sec_acc_no:    Optional[str] = None
        self._galletas:      dict = {}
        self.authenticated = False

    # ── WebSocket helpers ───────────────────────────────────────────────────

    def _cabeceras_ws(self) -> dict:
        """Cabeceras del saludo del WebSocket, con la sesión si la hay.

        Un navegador manda solas las galletas del dominio al abrir un
        WebSocket, y de ahí saca TR quién eres. Aquí hay que ponerlas a mano:
        `websockets` no lleva galletero.
        """
        cabeceras = dict(WS_HEADERS)
        if self._galletas:
            cabeceras["Cookie"] = "; ".join(f"{k}={v}" for k, v in self._galletas.items())
        return cabeceras

    async def _open_ws(self, token: str = "") -> None:
        """Abre el WebSocket y hace el saludo inicial.

        El protocolo de TR no es JSON puro: los mensajes llevan un prefijo de
        texto. El saludo es `connect <version> {json}` y la respuesta es la
        palabra `connected`, tal cual. Mandar un objeto JSON con
        `{"type": "connect"}` no da error — TR sencillamente no contesta, y el
        cliente se quedaba esperando o parseando lo que llegara despues.
        """
        self._ws = await websockets.connect(WS_URL, extra_headers=self._cabeceras_ws())
        self._counter = 1

        saludo = {
            "locale":          "es",
            "platformId":      "webApp",
            "platformVersion": "chrome - 125.0.0",
            "clientId":        "app.traderepublic.com",
            "clientVersion":   APP_VERSION,
        }
        if token:
            saludo["token"] = token
        await self._ws.send(f"connect {WS_VERSION} " + json.dumps(saludo))

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

    # ── Autenticación (REST) ────────────────────────────────────────────────
    #
    # TR retiró el login del WebSocket: `sub {"type":"login"}` responde
    # «Unknown topic type: login.31». Ahora se entra por REST, y el segundo
    # factor ya no es un SMS — o se aprueba desde la app del móvil, o se mete
    # un código de autenticador, según lo que diga `requiredAction`.

    def _cabeceras(self) -> dict:
        return {
            "Content-Type":     "application/json",
            "Origin":           "https://app.traderepublic.com",
            "Referer":          "https://app.traderepublic.com/",
            "User-Agent":       WS_HEADERS["User-Agent"],
            "Accept-Language":  "es-ES,es;q=0.9",
            "X-TR-App-Version": APP_VERSION,
            "X-Tr-Platform":    "web-pro",
            "X-TR-Device-Info": DEVICE_INFO,
        }

    def _http(self) -> httpx.AsyncClient:
        """Cliente con galletas propias: la sesión de la v2 vive en ellas."""
        if self._sesion_http is None:
            self._sesion_http = httpx.AsyncClient(
                base_url=API_URL, timeout=20, headers=self._cabeceras(), follow_redirects=True
            )
        return self._sesion_http

    @staticmethod
    def _detalle(respuesta) -> str:
        """Saca el motivo que da TR, que viene en una lista de errores."""
        try:
            errores = respuesta.json().get("errors") or []
        except Exception:
            return respuesta.text[:200]
        if not errores:
            return respuesta.text[:200]
        primero = errores[0]
        return primero.get("errorMessage") or primero.get("errorCode") or str(primero)

    async def login_init(self, phone: str, pin: str) -> dict:
        """Empieza el acceso. Devuelve qué segundo factor toca y cuánto queda.

        A diferencia de antes no devuelve solo un identificador: quien llama
        necesita saber si tiene que esperar una aprobación en el móvil o pedir
        un código, porque son dos pantallas distintas.
        """
        r = await self._http().post("/api/v2/auth/web/login", json={"phoneNumber": phone, "pin": pin})

        if r.status_code >= 400:
            detalle = self._detalle(r)
            # MISSING_REQUIRED_HEADER aqui no es una cabecera que se olvidara:
            # es la galleta `aws-waf-token` del sistema anti-bot de AWS, que
            # solo se consigue superando su desafio en un navegador. Decirlo
            # ahorra buscar durante horas una cabecera que no existe.
            if "MISSING_REQUIRED_HEADER" in detalle:
                raise TRAuthError(
                    "Trade Republic exige un token anti-bot de AWS para entrar por web, "
                    "y solo se obtiene superando su desafio en un navegador. AURUM no lo "
                    "hace por ti. Mira docs/BACKEND.md."
                )
            raise TRAuthError(f"Trade Republic ha rechazado el acceso: {detalle}")

        datos = r.json()
        self._process_id = datos.get("processId")
        if not self._process_id:
            raise TRAuthError(f"TR no ha devuelto processId: {str(datos)[:200]}")

        accion = datos.get("requiredAction") or datos.get("2fa") or "APP_CONFIRMATION"
        self._accion = accion
        logger.info(f"Login iniciado. Segundo factor: {accion}")

        return {
            "processId":      self._process_id,
            "requiredAction": accion,
            "expiresIn":      datos.get("countdownInSeconds"),
            # Si hay que meter un código, la pantalla lo pide; si no, se espera.
            "needsCode":      "AUTHENTICATOR" in str(accion).upper(),
        }

    async def login_verify(self, code: str = "") -> str:
        """Completa el acceso: con código, o esperando la aprobación del móvil."""
        if not self._process_id:
            raise TRAuthError("Llama primero a login_init().")

        if code:
            r = await self._http().post(
                f"/api/v2/auth/web/login/processes/{self._process_id}/authenticator-verification",
                json={"code": code},
            )
            if r.status_code >= 400:
                raise TRAuthError(f"El código no vale: {self._detalle(r)}")
        else:
            await self._esperar_aprobacion()

        # La sesión de la v2 viaja en galletas, no en un token dentro del
        # cuerpo. Se guarda la que sirva también para el WebSocket.
        galletas = self._http().cookies
        self._session_token = galletas.get("tr_session") or galletas.get("sessionToken") or ""
        if not self._session_token:
            raise TRAuthError(
                "El acceso ha ido bien pero no aparece la galleta de sesión. "
                f"Recibidas: {sorted(galletas.keys())}"
            )

        self.authenticated = True
        logger.info("Trade Republic autenticado")
        return self._session_token

    async def usar_sesion(self, galletas: str) -> dict:
        """Adopta una sesión que el usuario abrió en su propio navegador.

        Es la única vía que queda. TR puso su anti-bot delante de todos los
        puntos de acceso, así que entrar por programa exigiría resolver un
        desafío hecho justamente para distinguir personas de programas. Aquí no
        se resuelve nada: la persona entra como cualquier día y cede su sesión.

        Se valida abriendo el WebSocket y pidiendo el efectivo, que es lo que
        de verdad se va a usar después. Comprobarlo contra un endpoint REST
        cualquiera diría poco: lo que importa es si se puede leer la cuenta.
        """
        trozos = _parsear_galletas(galletas)
        if not trozos:
            raise TRAuthError(
                "No reconozco ninguna galleta en lo que has pegado. Copia la petición "
                "como cURL, o la línea entera de cabecera `Cookie`."
            )

        self._galletas = trozos
        # Solo los nombres: los valores son la credencial y no se registran.
        logger.info(f"Sesión recibida con galletas: {sorted(trozos)}")

        cliente = self._http()
        for nombre, valor in trozos.items():
            cliente.cookies.set(nombre, valor, domain=".traderepublic.com", path="/")

        await self.disconnect()
        await self._open_ws()

        try:
            datos = await self._sub({"type": "cash"})
        except TROrderError as e:
            self._galletas = {}
            if "AUTHENTICATION" in str(e).upper() or "TOKEN" in str(e).upper():
                raise TRAuthError(
                    "Trade Republic no acepta esa sesión: o ha caducado, o falta alguna "
                    "galleta. Vuelve a copiar la petición entera como cURL."
                ) from e
            raise TRAuthError(f"Trade Republic ha rechazado la sesión: {e}") from e

        self._session_token = trozos.get("tr_session", "")
        self.authenticated = True
        logger.info("Sesión de Trade Republic adoptada")
        return {"cash": datos}

    async def renovar_sesion(self) -> bool:
        """Comprueba que la sesión sigue viva. Devuelve si se puede seguir."""
        if not self._galletas:
            return False
        try:
            await self.ensure_connected()
            await self._sub({"type": "cash"})
            return True
        except Exception as e:
            self.authenticated = False
            logger.warning(f"La sesión de Trade Republic ya no vale: {e}")
            return False

    async def _esperar_aprobacion(self, espera_total: float = 120.0) -> None:
        """Sondea hasta que apruebas el acceso desde la app de Trade Republic."""
        limite = asyncio.get_event_loop().time() + espera_total
        while asyncio.get_event_loop().time() < limite:
            r = await self._http().get(f"/api/v2/auth/web/login/processes/{self._process_id}")
            if r.status_code >= 400:
                raise TRAuthError(f"El acceso se ha caído: {self._detalle(r)}")

            estado = str(r.json().get("status", "")).upper()
            if estado in ("CONFIRMED", "COMPLETED", "SUCCESS"):
                return
            if estado in ("REJECTED", "EXPIRED", "FAILED"):
                raise TRAuthError(f"El acceso ha quedado en {estado}. Vuelve a empezar.")
            await asyncio.sleep(2)

        raise TRAuthError("Se ha agotado la espera: no se ha aprobado el acceso desde el móvil.")

    # ── Conexión del WebSocket (para los datos) ─────────────────────────────

    async def connect(self) -> None:
        """Abre el WebSocket ya autenticado.

        El tema `auth` también desapareció, así que la sesión no se manda
        después de conectar: tiene que ir dentro del propio saludo.
        """
        if not self._galletas:
            raise TRAuthError("Sin sesión. Autentícate primero.")
        await self._open_ws()
        self.authenticated = True
        logger.info("Conectado a Trade Republic")

    # ── Portfolio ───────────────────────────────────────────────────────────

    async def _numero_de_cuenta(self) -> str:
        """El número de cuenta de valores, que `compactPortfolioByType` exige.

        Antes no hacía falta: el tema `portfolio` devolvía todo sin preguntar.
        TR lo retiró y el que lo sustituye va por cuenta, así que primero hay
        que averiguar cuál es la tuya.
        """
        if self._sec_acc_no:
            return self._sec_acc_no

        datos = await self._sub({"type": "accountPairs"})
        self._sec_acc_no = _buscar(datos, ("securitiesAccountNumber", "secAccNo", "accountNumber"))
        if not self._sec_acc_no:
            raise TRAuthError(
                "No encuentro el número de cuenta de valores en la respuesta de TR. "
                f"Claves recibidas: {_claves(datos)}"
            )
        return self._sec_acc_no

    async def get_portfolio(self) -> list[dict]:
        """Posiciones de la cartera.

        El tema `portfolio` desapareció («Unknown topic type: portfolio.31») y
        lo sustituye `compactPortfolioByType`. Los nombres de los campos se
        buscan con alternativas porque solo se pueden confirmar contra una
        cuenta viva; si no cuadra nada, se dice qué llegó en vez de devolver
        una cartera vacía, que se leería como «no tienes nada».
        """
        datos = await self._sub({
            "type":     "compactPortfolioByType",
            "secAccNo": await self._numero_de_cuenta(),
        })

        crudas = _lista_de_posiciones(datos)
        if crudas is None:
            raise TROrderError(
                "La cartera ha llegado con una forma que no reconozco. "
                f"Claves recibidas: {_claves(datos)}"
            )

        posiciones = []
        for item in crudas:
            isin = str(_buscar(item, ("isin", "instrumentId", "id")) or "").split(".")[0]
            if not isin:
                continue
            posiciones.append({
                "isin":          isin,
                "name":          _buscar(item, ("shortName", "name")) or isin,
                "shares":        _numero(item, ("netSize", "size", "quantity")),
                "avg_price":     _numero(item, ("averageBuyIn", "averagePrice", "buyInPrice")),
                "current_price": _numero(item, ("currentPrice", "lastPrice", "price")),
                "value":         _numero(item, ("netValue", "value", "marketValue")),
                "pnl_pct":       _numero(item, ("returnPercent", "performancePercent", "netPerformancePercent")),
            })
        return posiciones

    async def get_cash(self) -> float:
        """Efectivo disponible. `cash` sigue existiendo; los otros son respaldo."""
        for tema in ("cash", "availableCash", "availableCashForPayout"):
            try:
                datos = await self._sub({"type": tema})
            except (TROrderError, TRAuthError, TimeoutError):
                continue
            valor = _numero_suelto(datos, ("availableCash", "amount", "value", "cash"))
            if valor is not None:
                return valor
        return 0.0

    # ── Price ───────────────────────────────────────────────────────────────

    async def get_price(self, isin: str) -> float:
        data = await self._sub({"type": "ticker", "id": f"{isin}.EU"})
        return data.get("last", {}).get("price", 0)

    # ── Orders ──────────────────────────────────────────────────────────────
    #
    # `createOrder` tambien desaparecio del WebSocket («Unknown topic type:
    # createOrder.31»). Estas tres funciones estan sin migrar a proposito: las
    # ordenes van desactivadas de fabrica (AURUM_TRADING_ENABLED=false), asi
    # que nadie deberia llegar aqui. Si alguien las activa, es mejor decirle
    # por que no funciona que dejarle un error de protocolo sin explicar.

    async def _ordenes_sin_migrar(self) -> None:
        raise TROrderError(
            "Mandar ordenes a Trade Republic esta sin migrar: TR retiro el tema "
            "`createOrder` de su WebSocket. Leer la cartera si funciona."
        )


    async def buy_cash_amount(self, isin: str, amount_eur: float) -> dict:
        logger.info(f"Comprando {amount_eur}€ de {isin}…")
        await self._ordenes_sin_migrar()
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
        await self._ordenes_sin_migrar()
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
        await self._ordenes_sin_migrar()
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


# ── Lectura tolerante de las respuestas ─────────────────────────────────────
#
# TR cambia nombres de campos sin avisar —de ahí viene todo esto— así que en
# vez de acceder a una clave concreta se busca entre las que puede usar. No es
# elegante; es lo que evita que un renombrado deje la cartera en blanco sin
# que nadie se entere.


def _claves(datos: Any) -> Any:
    """Qué venía en la respuesta, para poder decirlo en el error."""
    if isinstance(datos, dict):
        return sorted(datos.keys())
    if isinstance(datos, list):
        return f"lista de {len(datos)}" + (f", primer elemento {_claves(datos[0])}" if datos else "")
    return type(datos).__name__


def _buscar(datos: Any, nombres: tuple[str, ...], profundidad: int = 3) -> Any:
    """Primer valor no vacío bajo cualquiera de esos nombres, mirando dentro."""
    if profundidad < 0:
        return None
    if isinstance(datos, dict):
        for nombre in nombres:
            valor = datos.get(nombre)
            if valor not in (None, "", [], {}):
                return valor
        for valor in datos.values():
            encontrado = _buscar(valor, nombres, profundidad - 1)
            if encontrado is not None:
                return encontrado
    elif isinstance(datos, list):
        for elemento in datos:
            encontrado = _buscar(elemento, nombres, profundidad - 1)
            if encontrado is not None:
                return encontrado
    return None


def _numero(item: Any, nombres: tuple[str, ...]) -> float:
    valor = _buscar(item, nombres)
    try:
        return float(valor)
    except (TypeError, ValueError):
        return 0.0


def _numero_suelto(datos: Any, nombres: tuple[str, ...]) -> Optional[float]:
    valor = _buscar(datos, nombres)
    if isinstance(valor, list) and valor:
        valor = _buscar(valor[0], nombres + ("amount", "value"))
    try:
        return float(valor)
    except (TypeError, ValueError):
        return None


def _lista_de_posiciones(datos: Any) -> Optional[list]:
    """Encuentra la lista de posiciones, venga suelta o dentro de una clave."""
    if isinstance(datos, list):
        return datos
    if isinstance(datos, dict):
        for nombre in ("positions", "securities", "items", "portfolio"):
            valor = datos.get(nombre)
            if isinstance(valor, list):
                return valor
        # `compactPortfolioByType` agrupa por tipo de producto: una lista de
        # categorías, cada una con sus posiciones dentro.
        for valor in datos.values():
            if isinstance(valor, list) and valor and isinstance(valor[0], dict):
                dentro = [p for c in valor for p in (_lista_de_posiciones(c) or [])]
                if dentro:
                    return dentro
    return None


def _entre_comillas(texto: str) -> str:
    """Lo que hay hasta la siguiente comilla, que es donde acaba el argumento."""
    posiciones = [p for p in (texto.find("'"), texto.find('"')) if p != -1]
    return texto[:min(posiciones)] if posiciones else texto


def _sacar_de_curl(crudo: str) -> str:
    """Extrae las galletas de un «Copiar como cURL» del navegador.

    Buscar la cabecera `Cookie` a mano entre cuarenta es donde se atasca
    cualquiera; copiar como cURL es un clic derecho. Se hace a mano y no con
    una expresión regular porque aquí se lee mejor lo que ocurre.
    """
    bajo = crudo.lower()

    # Forma habitual de Chrome y Firefox: -H 'cookie: a=1; b=2'
    i = bajo.find("cookie:")
    if i != -1:
        return _entre_comillas(crudo[i + len("cookie:"):]).strip()

    # Forma de curl a secas: -b 'a=1; b=2' o --cookie 'a=1; b=2'
    for bandera in ("--cookie", "-b "):
        i = bajo.find(bandera)
        if i == -1:
            continue
        resto = crudo[i + len(bandera):].lstrip()
        if resto[:1] in ("'", '"'):
            resto = resto[1:]
        return _entre_comillas(resto).strip()

    return crudo


def _parsear_galletas(crudo: str) -> dict:
    """Entiende lo que sea que el usuario haya conseguido copiar.

    Vale un «Copiar como cURL», la cabecera `Cookie` entera (`a=1; b=2`), una
    sola pareja, o el valor suelto del token. Pedirle a alguien que acierte con
    el formato exacto es pedirle que falle: lo que llega se interpreta.
    """
    crudo = (crudo or "").strip()
    if not crudo:
        return {}

    if "curl" in crudo[:80].lower():
        crudo = _sacar_de_curl(crudo)

    crudo = crudo.strip().strip('"').strip("'").strip()

    # Por si pega la línea entera tal como la muestra el navegador.
    if crudo.lower().startswith("cookie:"):
        crudo = crudo.split(":", 1)[1].strip()

    # Una cabecera copiada de la pantalla puede venir partida en varias líneas.
    crudo = " ".join(crudo.split())

    if "=" not in crudo:
        # Solo el valor: se asume el nombre que usa TR.
        return {"tr_session": crudo}

    trozos = {}
    for parte in crudo.split(";"):
        parte = parte.strip()
        if "=" not in parte:
            continue
        nombre, _, valor = parte.partition("=")
        nombre, valor = nombre.strip(), valor.strip()
        if nombre and valor:
            trozos[nombre] = valor
    return trozos
